"use client";
import { useEffect, useRef, useState } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import {
  Input,
  TransportError,
  useBindings,
  useConnection,
  useLive,
  useRestoredFields,
} from "luciole/client";
import { abort, feed, newSession, sendPrompt } from "../actions/agent";
import { Frame } from "./Frame";
import { Line } from "./Line";
import type { AgentState, SendResult, Snapshot } from "./model";
import { color } from "./theme";
import { Transcript, blockId, foldable } from "./Transcript";

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const SPINNER_MS = 80;
// A second Ctrl+N within this delay confirms a new session.
const CONFIRM_MS = 3000;
// Page Up/Down move the transcript by this many rows.
const PAGE_ROWS = 10;
const THOUSAND = 1000;
// Session ids are UUIDv7: the start is a timestamp, the end tells sessions apart.
const SESSION_ID_SHOWN = 8;

type Mode = "compose" | "browse";

const stateLabel: Record<AgentState, { text: string; fg: string }> = {
  starting: { text: "starting pi…", fg: color.warn },
  idle: { text: "idle", fg: color.ok },
  running: { text: "running", fg: color.warn },
  aborting: { text: "interrupting…", fg: color.danger },
  stopped: { text: "stopped", fg: color.danger },
};

const tokens = (n: number) => (n >= THOUSAND ? `${(n / THOUSAND).toFixed(1)}k` : String(n));
const failure = (error: unknown) =>
  error instanceof TransportError
    ? `${error.message} (${error.outcome})`
    : error instanceof Error
      ? error.message
      : "Request failed";

/**
 * The agent screen. Everything it shows comes from one live subscription (`feed`): the
 * Server pushes a snapshot after each pi event. The prompt, the folds and the selection
 * are local; sending, interrupting and resetting are Server Functions.
 */
export function AgentScreen({ initial }: { initial: Snapshot }) {
  const [attempt, setAttempt] = useState(0);
  const live = useLive(feed, [attempt], { limit: 1 });
  const snap = live.items.at(-1) ?? initial;
  const { refresh } = useConnection();
  const fields = useRestoredFields("agent");
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<Mode>("compose");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; fg: string } | null>(null);
  const [confirmNew, setConfirmNew] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const scroll = useRef<ScrollBoxRenderable>(null);

  const busy = snap.state === "running" || snap.state === "aborting";
  const folds = snap.blocks.filter(foldable).map((b) => b.id);
  const lost = live.done;

  // The spinner and the running tool's clock tick locally, only while pi works.
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setNow(Date.now()), SPINNER_MS);
    return () => clearInterval(timer);
  }, [busy]);
  useEffect(() => {
    if (!confirmNew) return;
    const timer = setTimeout(() => setConfirmNew(false), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [confirmNew]);

  async function run(label: string, call: () => Promise<SendResult>) {
    setMessage(null);
    try {
      const result = await call();
      if (!result.ok) setMessage({ text: `${label}: ${result.error}`, fg: color.danger });
      return result.ok;
    } catch (error: unknown) {
      setMessage({ text: `${label}: ${failure(error)}`, fg: color.danger });
      return false;
    }
  }

  async function send() {
    const text = prompt.trim();
    if (!text) return;
    setPrompt("");
    // The typed text is forgotten while the request runs and kept again if it failed
    // without reaching pi; then it goes back into the field.
    const sent = await run(busy ? "Steer" : "Send", () =>
      fields.submit(() => sendPrompt(text), { failed: (r) => !r.ok }),
    );
    if (!sent) setPrompt((current) => current || text);
    else scroll.current?.scrollTo(scroll.current.scrollHeight);
  }

  function startNew() {
    if (snap.blocks.length && !confirmNew) {
      setConfirmNew(true);
      return;
    }
    setConfirmNew(false);
    setExpanded(new Set());
    setSelected(null);
    setMode("compose");
    void run("New session", newSession);
  }

  function toggle(id: string) {
    setSelected(id);
    setExpanded((open) => {
      const next = new Set(open);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function select(delta: number) {
    if (!folds.length) return;
    const index = selected ? folds.indexOf(selected) : -1;
    const start = index < 0 ? (delta > 0 ? -1 : folds.length) : index;
    const next = folds[Math.max(0, Math.min(folds.length - 1, start + delta))] ?? null;
    setSelected(next);
    if (next) scroll.current?.scrollChildIntoView(blockId(next));
  }

  function browse() {
    setMode("browse");
    // Start from the most recent call: usually the one worth opening.
    if (!selected || !folds.includes(selected)) {
      const last = folds.at(-1) ?? null;
      setSelected(last);
      if (last) scroll.current?.scrollChildIntoView(blockId(last));
    }
  }

  const page = (rows: number) => scroll.current?.scrollBy(rows);

  useBindings(
    () => ({
      bindings: [
        {
          key: "ctrl+n",
          cmd: startNew,
          desc: confirmNew ? "confirm new" : "new session",
          group: "agent",
        },
        ...(busy
          ? [
              {
                key: "ctrl+x",
                cmd: () => void run("Interrupt", abort),
                desc: "interrupt",
                group: "agent",
              },
            ]
          : []),
        {
          key: "ctrl+r",
          cmd: () => {
            // A closed feed does not come back by itself: a new argument reopens it.
            if (lost) setAttempt((n) => n + 1);
            void refresh();
          },
          // Always bound; named only when the feed needs it.
          ...(lost ? { desc: "reconnect", group: "global" } : {}),
        },
        { key: "pageup", cmd: () => page(-PAGE_ROWS), desc: "scroll", group: "agent" },
        { key: "pagedown", cmd: () => page(PAGE_ROWS) },
        ...(mode === "compose"
          ? folds.length
            ? [{ key: "escape", cmd: browse, desc: "browse tools", group: "agent" }]
            : []
          : [
              { key: "j", cmd: () => select(1), desc: "select", group: "agent" },
              { key: "k", cmd: () => select(-1) },
              { key: "down", cmd: () => select(1) },
              { key: "up", cmd: () => select(-1) },
              ...(selected
                ? [
                    { key: "return", cmd: () => toggle(selected), desc: "fold", group: "agent" },
                    { key: "space", cmd: () => toggle(selected) },
                  ]
                : []),
              {
                key: "a",
                cmd: () =>
                  setExpanded((open) =>
                    folds.every((id) => open.has(id)) ? new Set() : new Set(folds),
                  ),
                desc: "fold all",
                group: "agent",
              },
              { key: "i", cmd: () => setMode("compose"), desc: "prompt", group: "agent" },
              { key: "escape", cmd: () => setMode("compose") },
            ]),
      ],
    }),
    [mode, busy, lost, selected, folds.join(), confirmNew, snap.blocks.length, prompt],
  );

  const label = stateLabel[snap.state];
  const tools = snap.blocks.filter((b) => b.kind === "tool").length;
  const spinner = SPINNER[Math.floor(now / SPINNER_MS) % SPINNER.length];
  const status = confirmNew
    ? { text: "Ctrl+N again starts a new session; this one stays in pi's history", fg: color.warn }
    : lost
      ? { text: "Live feed closed · Ctrl+R to reconnect", fg: color.danger }
      : (message ??
        (snap.error ? { text: snap.error, fg: color.danger } : null) ??
        (snap.queued.length
          ? { text: `${snap.queued.length} message(s) queued for the next turn`, fg: color.info }
          : null));

  return (
    <Frame
      title={
        <>
          AGENT · <span fg={color.text}>{snap.model}</span>
          <span fg={color.muted}> · thinking {snap.thinking}</span>
        </>
      }
      subtitle={`${snap.cwd}${snap.sessionId ? ` · session ${snap.sessionId.slice(-SESSION_ID_SHOWN)}` : ""}`}
      promptFocused={mode === "compose"}
      status={
        <>
          <text flexShrink={0} fg={label.fg}>
            {busy ? `${spinner} ` : "● "}
            {label.text}
          </text>
          <text flexGrow={1} flexShrink={1} wrapMode="none" truncate fg={status?.fg ?? color.muted}>
            {status ? ` · ${status.text}` : ""}
          </text>
          <text flexShrink={0} fg={color.faint}>
            {tools} tool call(s) · ↑{tokens(snap.usage.input)} ↓{tokens(snap.usage.output)} tokens
          </text>
        </>
      }
      prompt={
        <Input
          id="prompt-input"
          name="agent/prompt"
          focused={mode === "compose"}
          value={prompt}
          onInput={setPrompt}
          onSubmit={() => void send()}
          placeholder={
            busy
              ? "Steer the agent: delivered after the current tool call"
              : "Ask the agent (Enter sends)"
          }
          textColor={color.text}
          placeholderColor={color.faint}
          focusedBackgroundColor={color.panel}
        />
      }
    >
      <Transcript
        blocks={snap.blocks}
        expanded={expanded}
        selected={mode === "browse" ? selected : null}
        now={now}
        onToggle={toggle}
        scroll={scroll}
      />
      {snap.state === "starting" && !snap.blocks.length ? (
        <Line fg={color.muted}> Starting pi…</Line>
      ) : null}
    </Frame>
  );
}
