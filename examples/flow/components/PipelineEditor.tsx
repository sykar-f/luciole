"use client";
import { useEffect, useRef, useState } from "react";
import { Input, TransportError, useBindings, useLive } from "@luciole-sh/core/client";
import {
  Background,
  Controls,
  Flow,
  FlowProvider,
  MiniMap,
  useEdgesState,
  useFlow,
  useNodesState,
  type Edge,
  type EdgeChange,
  type NodeChange,
} from "@luciole-sh/flow-graph";
import {
  addStep,
  connectSteps,
  loadPipeline,
  moveSteps,
  removeElements,
  renameStep,
  startRun,
  watchRun,
} from "../actions/pipeline";
import { IDLE, STATUS_ICON, type Link, type Pipeline, type Result, type Run } from "./model";
import { StepNode, type StepNodeType } from "./StepNode";
import { color, statusColor } from "./theme";

const MOVE_DEBOUNCE_MS = 250;
const MESSAGE_MS = 4000;
const RECONNECT_MS = 1000;
const INSPECTOR_WIDTH = 30;
const INSPECTOR_FRAME = 6;
const BAR = INSPECTOR_WIDTH - INSPECTOR_FRAME;
const MS_PER_SECOND = 1000;
const NODE_TYPES = { step: StepNode };

const toNodes = (pipeline: Pipeline): StepNodeType[] =>
  pipeline.steps.map((s) => ({
    id: s.id,
    type: s.kind === "group" ? "group" : "step",
    position: { x: s.x, y: s.y },
    parentId: s.parent,
    width: s.width,
    height: s.height,
    data: { label: s.name, command: s.command, kind: s.kind, run: IDLE },
  }));
const toEdge = (l: Link): Edge => ({ id: l.id, source: l.from, target: l.to, label: l.label });

const failure = (error: unknown) =>
  error instanceof TransportError
    ? `${error.message} (${error.outcome})`
    : error instanceof Error
      ? error.message
      : "Request failed";

/**
 * The pipeline on a canvas, and the selected step beside it. Pan, zoom, drag and selection
 * stay here; what changes the pipeline (moves, new steps, links, names, removals, runs) is
 * sent to the Server, which keeps it and runs it.
 */
export function PipelineEditor(props: { initial: Pipeline; run: Run }) {
  return (
    <FlowProvider fitView>
      <Editor {...props} />
    </FlowProvider>
  );
}

function Editor({ initial, run: initialRun }: { initial: Pipeline; run: Run }) {
  const flow = useFlow();
  const [nodes, setNodes, applyNodes] = useNodesState(toNodes(initial));
  const [edges, setEdges, applyEdges] = useEdgesState(initial.links.map(toEdge));
  const [attempt, setAttempt] = useState(0);
  const live = useLive(watchRun, [attempt], { limit: 1 });
  const run = live.items.at(-1) ?? initialRun;
  const [message, setMessage] = useState<{ text: string; fg: string } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const moves = useRef(new Map<string, { x: number; y: number }>());
  const moveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const removal = useRef<{ steps: string[]; links: string[] } | null>(null);

  const say = (text: string, fg: string = color.muted) => setMessage({ text, fg });
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), MESSAGE_MS);
    return () => clearTimeout(timer);
  }, [message]);
  // A dropped feed is opened again: the run goes on without us.
  useEffect(() => {
    if (!live.error) return;
    const timer = setTimeout(() => setAttempt((n) => n + 1), RECONNECT_MS);
    return () => clearTimeout(timer);
  }, [live.error]);

  /** Puts the pipeline back as the Server has it, after a change it refused. */
  async function resync() {
    try {
      const pipeline = await loadPipeline();
      setNodes(toNodes(pipeline));
      setEdges(pipeline.links.map(toEdge));
    } catch (error: unknown) {
      say(`Reload: ${failure(error)}`, color.failed);
    }
  }
  async function send<T extends Record<string, unknown>>(
    label: string,
    call: () => Promise<Result<T>>,
  ): Promise<T | null> {
    try {
      const result = await call();
      if (result.ok) return result;
      say(`${label}: ${result.error}`, color.failed);
    } catch (error: unknown) {
      say(`${label}: ${failure(error)}`, color.failed);
    }
    void resync();
    return null;
  }

  // Removals come as edge changes then node changes, in one interaction: sent together.
  const remove = (kind: "steps" | "links", ids: string[]) => {
    if (ids.length === 0) return;
    if (!removal.current) {
      removal.current = { steps: [], links: [] };
      queueMicrotask(() => {
        const r = removal.current;
        removal.current = null;
        if (r) void send("Remove", () => removeElements(r.steps, r.links));
      });
    }
    removal.current[kind].push(...ids);
  };
  const onNodesChange = (changes: NodeChange<StepNodeType>[]) => {
    applyNodes(changes);
    remove(
      "steps",
      changes.flatMap((c) => (c.type === "remove" ? [c.id] : [])),
    );
    // Moves are sent once they settle: at a drag's end, or after a burst of keys.
    for (const c of changes)
      if (c.type === "position" && c.position && !c.dragging) moves.current.set(c.id, c.position);
    if (moves.current.size === 0) return;
    clearTimeout(moveTimer.current);
    moveTimer.current = setTimeout(() => {
      const batch = [...moves.current].map(([id, p]) => ({ id, x: p.x, y: p.y }));
      moves.current.clear();
      void send("Move", () => moveSteps(batch));
    }, MOVE_DEBOUNCE_MS);
  };
  const onEdgesChange = (changes: EdgeChange[]) => {
    applyEdges(changes);
    remove(
      "links",
      changes.flatMap((c) => (c.type === "remove" ? [c.id] : [])),
    );
  };

  const selected = nodes.find((n) => n.selected && n.type !== "group");
  const selectedEdge = edges.find((e) => e.selected);

  async function add() {
    const result = await send("Add", () => addStep(selected?.id ?? null));
    if (!result) return;
    const { step, link } = result;
    const [node] = toNodes({ name: "", steps: [step], links: [] });
    if (!node) return;
    setNodes((current) => [
      ...current.map((n) => (n.selected ? { ...n, selected: false } : n)),
      { ...node, selected: true },
    ]);
    if (link) setEdges((current) => [...current, toEdge(link)]);
    say(`Added ${step.name}${link ? ` after ${selected?.data.label ?? ""}` : ""}`, color.passed);
    setTimeout(() => flow.reveal(step.id));
  }
  async function launch() {
    const result = await send("Run", startRun);
    if (result) say(`Run #${result.number} started`, color.running);
  }
  async function rename(id: string, name: string) {
    setRenaming(null);
    if (!(await send("Rename", () => renameStep(id, name)))) return;
    setNodes((current) =>
      current.map((n) => (n.id === id ? { ...n, data: { ...n.data, label: name.trim() } } : n)),
    );
  }

  const [draft, setDraft] = useState("");
  useBindings(
    () => ({
      bindings: renaming
        ? [{ key: "escape", cmd: () => setRenaming(null), desc: "cancel", group: "pipeline" }]
        : [
            { key: "a", cmd: () => void add(), desc: "add step", group: "pipeline" },
            { key: "r", cmd: () => void launch(), desc: "run", group: "pipeline" },
            ...(selected
              ? [
                  {
                    key: "n",
                    cmd: () => {
                      setDraft(selected.data.label);
                      setRenaming(selected.id);
                    },
                    desc: "rename",
                    group: "pipeline",
                  },
                ]
              : []),
          ],
    }),
    [renaming, selected?.id, selected?.data.label, run.state],
  );

  // What the canvas draws: the application's nodes and edges, with the run's state.
  const shownNodes = nodes.map((n) => {
    const state = run.steps[n.id] ?? IDLE;
    return n.type === "group"
      ? n
      : { ...n, color: statusColor[state.status], data: { ...n.data, run: state } };
  });
  const shownEdges = edges.map((e) => {
    const from = run.steps[e.source]?.status;
    const to = run.steps[e.target]?.status;
    return {
      ...e,
      animated: from === "passed" && to === "running",
      color: from === "failed" ? color.failed : from === "passed" ? color.passed : undefined,
    };
  });
  const counts = Object.values(run.steps).reduce<Record<string, number>>((acc, s) => {
    acc[s.status] = (acc[s.status] ?? 0) + 1;
    return acc;
  }, {});
  const runColor =
    run.state === "failed" ? color.failed : run.state === "passed" ? color.passed : color.running;

  return (
    <box flexDirection="column" flexGrow={1}>
      <box height={1} flexShrink={0} flexDirection="row" paddingX={1} gap={2}>
        <text fg={color.accent} flexShrink={0}>
          ◆ pipeline · {initial.name}
        </text>
        <text fg={run.state === "idle" ? color.muted : runColor} flexShrink={0}>
          {run.number === 0 ? "never run" : `run #${run.number} · ${run.state}`}
          {run.state === "running"
            ? ` · ${counts.passed ?? 0}/${Object.keys(run.steps).length}`
            : ""}
        </text>
        <text fg={message?.fg ?? color.muted} wrapMode="none" truncate>
          {message?.text ?? ""}
        </text>
      </box>
      <box flexDirection="row" flexGrow={1}>
        <box flexGrow={1} border borderStyle="rounded" borderColor={color.border}>
          <Flow
            id="flow-canvas"
            nodes={shownNodes}
            edges={shownEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={(c) =>
              void send("Link", () => connectSteps(c.source, c.target)).then((result) => {
                if (result) setEdges((current) => [...current, toEdge(result.link)]);
              })
            }
            nodeTypes={NODE_TYPES}
            keyboard={!renaming}
          >
            <Background />
            <MiniMap />
            <Controls />
          </Flow>
        </box>
        <box
          id="flow-inspector"
          width={INSPECTOR_WIDTH}
          flexShrink={0}
          border
          borderStyle="rounded"
          borderColor={selected ? color.accent : color.border}
          title={selected ? " step " : " pipeline "}
          flexDirection="column"
          paddingX={1}
        >
          {selected ? (
            <StepDetails
              step={selected}
              run={run}
              edges={edges}
              nodes={nodes}
              renaming={renaming === selected.id}
              draft={draft}
              onDraft={setDraft}
              onRename={(name) => void rename(selected.id, name)}
            />
          ) : (
            <>
              <text fg={color.text}>{initial.name}</text>
              <text fg={color.muted}>
                {nodes.filter((n) => n.type !== "group").length} steps · {edges.length} links
              </text>
              <text> </text>
              {run.number > 0 ? (
                <>
                  <text fg={runColor}>
                    run #{run.number} · {run.state}
                  </text>
                  {(["passed", "running", "failed", "skipped", "queued"] as const).map((s) =>
                    counts[s] ? (
                      <text key={s} fg={statusColor[s]}>
                        {STATUS_ICON[s]} {counts[s]} {s}
                      </text>
                    ) : null,
                  )}
                </>
              ) : (
                <text fg={color.muted}>r runs the pipeline</text>
              )}
              <text> </text>
              {selectedEdge ? (
                <text fg={color.accent}>
                  link {selectedEdge.source} → {selectedEdge.target} · x removes it
                </text>
              ) : (
                <>
                  <text fg={color.muted}>tab or a click: a step</text>
                  <text fg={color.faint}>hjkl pan · HJKL move</text>
                  <text fg={color.faint}>] [ follow links · c link</text>
                </>
              )}
            </>
          )}
        </box>
      </box>
    </box>
  );
}

function StepDetails({
  step,
  run,
  edges,
  nodes,
  renaming,
  draft,
  onDraft,
  onRename,
}: {
  step: StepNodeType;
  run: Run;
  edges: readonly Edge[];
  nodes: readonly StepNodeType[];
  renaming: boolean;
  draft: string;
  onDraft: (text: string) => void;
  onRename: (name: string) => void;
}) {
  const state = run.steps[step.id] ?? IDLE;
  const name = (id: string) => nodes.find((n) => n.id === id)?.data.label ?? id;
  const after = edges.filter((e) => e.target === step.id).map((e) => name(e.source));
  const before = edges.filter((e) => e.source === step.id).map((e) => name(e.target));
  const filled = Math.round(state.progress * BAR);
  return (
    <>
      {renaming ? (
        <box height={1} flexDirection="row">
          <text fg={color.accent}>› </text>
          <Input
            focused
            value={draft}
            onInput={onDraft}
            onSubmit={() => onRename(draft)}
            textColor={color.text}
            focusedTextColor={color.text}
          />
        </box>
      ) : (
        <text fg={color.text}>
          <strong>{step.data.label}</strong>
          <span fg={color.muted}> · {step.data.kind}</span>
        </text>
      )}
      <text fg={color.muted} wrapMode="none" truncate>
        $ {step.data.command}
      </text>
      <text> </text>
      <text fg={statusColor[state.status]}>
        {STATUS_ICON[state.status]} {state.status}
        {state.ms > 0 ? ` · ${(state.ms / MS_PER_SECOND).toFixed(1)}s` : ""}
      </text>
      <text fg={color.running}>
        {"█".repeat(filled)}
        <span fg={color.faint}>{"░".repeat(BAR - filled)}</span>
      </text>
      <text> </text>
      <text fg={color.muted} wrapMode="none" truncate>
        after: {after.join(", ") || "—"}
      </text>
      <text fg={color.muted} wrapMode="none" truncate>
        before: {before.join(", ") || "—"}
      </text>
      <text> </text>
      <text fg={color.faint}>
        {renaming ? "enter saves · esc cancels" : "n rename · c link · x del"}
      </text>
    </>
  );
}
