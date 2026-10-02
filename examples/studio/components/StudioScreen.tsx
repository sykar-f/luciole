"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import {
  Textarea,
  TransportError,
  useBindings,
  useLive,
  useRestoredFields,
} from "@luciole-sh/core/client";
import type {
  FilePatch,
  Item,
  Request,
  Response,
  Result,
  Snapshot,
} from "@luciole-sh/harness/model";
import { Overlay, RequestDialog } from "@luciole-sh/harness/ui/Dialogs";
import { Line } from "@luciole-sh/harness/ui/Line";
import { Picker } from "@luciole-sh/harness/ui/Picker";
import { StatusLine } from "@luciole-sh/harness/ui/StatusLine";
import { FeedStore } from "@luciole-sh/harness/ui/store";
import { color } from "@luciole-sh/harness/ui/theme";
import { foldable, openByDefault, Patch, Transcript } from "@luciole-sh/harness/ui/Transcript";
import {
  allowHost,
  feed,
  interrupt,
  patch,
  previewFailed,
  requestState,
  respond,
  restart,
  restore,
  send,
  state,
} from "../actions/studio";
import { STAGE_LABELS, type StudioSnapshot } from "./model";
import { Preview } from "./Preview";

/** The host's only key: every other one goes to the focused pane, the app's included. */
const PREFIX = "ctrl+o";
// Side by side from this width; below it, one pane at a time.
const SIDE_BY_SIDE_COLUMNS = 120;
const LIVE_LIMIT = 200;
const COMPOSER_MAX_LINES = 6;
const SPINNER = "◐◓◑◒";
const SPINNER_MS = 250;
const MESSAGE_MS = 5000;
const REVISIONS_SHOWN = 20;
const DIFF_ROWS = 30;
const COMPOSER_KEYS = [
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "linefeed", action: "newline" },
] as const;

type Pane = "chat" | "preview";
type Panel =
  | { kind: "revisions" }
  | { kind: "diff"; revision: number; files?: FilePatch[]; error?: string };
type Message = { text: string; fg: string };

const failure = (error: unknown) =>
  error instanceof TransportError
    ? `${error.message} (${error.outcome})`
    : error instanceof Error
      ? error.message
      : "Request failed";

/** The last value a live feed gave, or `initial`. */
function useLatest<T>(items: readonly T[], initial: T) {
  return items.at(-1) ?? initial;
}

/**
 * The studio: the conversation with the harness on one side, the app it writes, running,
 * on the other. Both follow live feeds (`feed`: the harness session; `state`: project,
 * revisions, validation, preview); everything else is a Server Function answering at once.
 */
export function StudioScreen({ initial, studio }: { initial: Snapshot; studio: StudioSnapshot }) {
  const [attempt, setAttempt] = useState(0);
  const live = useLive(feed, [attempt], { limit: LIVE_LIMIT });
  const [store] = useState(() => new FeedStore(initial));
  useEffect(() => {
    store.follow(attempt, live.items, () => setAttempt((n) => n + 1));
  }, [store, attempt, live.items]);
  const snap = useSyncExternalStore(store.subscribe, store.get);
  const studioLive = useLive(state, [], { limit: 1 });
  const s = useLatest(studioLive.items, studio);

  const { width } = useTerminalDimensions();
  const fields = useRestoredFields("studio");
  const field = useRef<TextareaRenderable>(null);
  const scroll = useRef<ScrollBoxRenderable>(null);
  const [text, setText] = useState("");
  const [pane, setPane] = useState<Pane>("chat");
  const [full, setFull] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [folds, setFolds] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [sticky, setSticky] = useState(true);
  const [message, setMessage] = useState<Message | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [answering, setAnswering] = useState<ReadonlySet<string>>(new Set());
  const [exited, setExited] = useState<{ id: string; code: number | null } | null>(null);

  const busy = snap.state === "running" || snap.state === "interrupting";
  const validating = s.validation.state === "validating";
  const request = snap.requests.find((r) => !answering.has(r.id));
  const sideBySide = width >= SIDE_BY_SIDE_COLUMNS && !full;
  const composing = pane === "chat" && !panel && !request;
  const say = (text: string, fg: string = color.muted) => setMessage({ text, fg });

  useEffect(() => {
    if (!busy && !validating) return;
    const timer = setInterval(() => setNow(Date.now()), SPINNER_MS);
    return () => clearInterval(timer);
  }, [busy, validating]);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), MESSAGE_MS);
    return () => clearTimeout(timer);
  }, [message]);
  const revision = s.preview?.revision;
  // A new revision or draft is a new program in the preview: an end, if any, is its own.
  const ended = exited && exited.id === s.preview?.id ? exited : null;

  async function run(label: string, call: () => Promise<Result>) {
    try {
      const result = await call();
      if (!result.ok) say(`${label}: ${result.error}`, color.danger);
      return result.ok;
    } catch (error: unknown) {
      say(`${label}: ${failure(error)}`, color.danger);
      return false;
    }
  }

  const commands: Record<string, (rest: string) => void> = {
    allow: (host) =>
      void run("Allow", () => allowHost(host, true)).then((ok) => ok && say(`${host} allowed`)),
    deny: (host) => void run("Deny", () => allowHost(host, false)),
    restore: (rest) => void run("Restore", () => restore(Number(rest.replace(/^r/, "")))),
    restart: () => {
      setExited(null);
      void run("Restart", restart);
    },
    revisions: () => setPanel({ kind: "revisions" }),
  };

  async function submit() {
    const value = (field.current?.plainText ?? text).trim();
    if (!value) return;
    field.current?.setText("");
    setText("");
    if (value.startsWith("/")) {
      const [name = "", ...rest] = value.slice(1).split(/\s+/);
      const command = commands[name];
      if (command) return command(rest.join(" "));
      return say(
        `Unknown command /${name}: /allow HOST, /deny HOST, /restore N, /restart, /revisions`,
        color.warn,
      );
    }
    setSticky(true);
    scroll.current?.scrollTo(scroll.current.scrollHeight);
    if (busy) return say("The harness is still working: wait, or Esc to interrupt", color.warn);
    const sent = await run("Send", () =>
      fields.submit(() => send(value), { failed: (r) => !r.ok }),
    );
    if (!sent) setText((current) => current || value);
  }

  async function answer(target: Request, response: Response) {
    setAnswering((ids) => new Set(ids).add(target.id));
    const reopen = (text: string) => {
      setAnswering((ids) => {
        const next = new Set(ids);
        next.delete(target.id);
        return next;
      });
      say(text, color.danger);
    };
    try {
      const result = await respond(target.id, response);
      if (!result.ok) reopen(result.error);
    } catch (error: unknown) {
      if (!(error instanceof TransportError) || error.outcome !== "unknown")
        return reopen(`Not sent: ${failure(error)}`);
      // It may have reached the harness: never answered twice, looked up instead.
      const where = await requestState(target.id).catch(() => undefined);
      if (!where || where.state === "pending") reopen("The answer did not arrive: answer again");
    }
  }

  const openDiff = (number: number) => {
    setPanel({ kind: "diff", revision: number });
    void patch(number).then(
      (result) =>
        setPanel((p) =>
          p?.kind === "diff" && p.revision === number
            ? result.ok
              ? { ...p, files: result.files }
              : { ...p, error: result.error }
            : p,
        ),
      (error: unknown) => say(`Diff: ${failure(error)}`, color.danger),
    );
  };
  const previous = s.revisions[1]?.number;

  useBindings(
    () => ({
      bindings: [
        {
          key: `${PREFIX}o`,
          cmd: () => setPane((p) => (p === "chat" ? "preview" : "chat")),
          desc: "chat ↔ app",
          group: "studio",
        },
        {
          key: `${PREFIX}p`,
          cmd: () => setFull((f) => !f),
          desc: "app full screen",
          group: "studio",
        },
        {
          key: `${PREFIX}r`,
          cmd: () => commands.restart?.(""),
          desc: "restart app",
          group: "studio",
        },
        {
          key: `${PREFIX}u`,
          cmd: () =>
            previous === undefined
              ? say("Nothing to undo", color.warn)
              : void run("Undo", () => restore(previous)),
          desc: "undo",
          group: "studio",
        },
        {
          key: `${PREFIX}d`,
          cmd: () => (revision === undefined ? say("No revision yet") : openDiff(revision)),
          desc: "diff",
          group: "studio",
        },
        {
          key: `${PREFIX}h`,
          cmd: () => setPanel({ kind: "revisions" }),
          desc: "revisions",
          group: "studio",
        },
        ...(composing && busy
          ? [
              {
                key: "escape",
                cmd: () => void run("Interrupt", interrupt),
                desc: "interrupt",
                group: "studio",
              },
            ]
          : []),
        ...(panel
          ? [{ key: "escape", cmd: () => setPanel(null), desc: "close", group: "studio" }]
          : []),
      ],
    }),
    [composing, busy, panel, previous, revision],
  );

  const isOpen = (item: Item) =>
    foldable(item) ? (folds.get(item.id) ?? openByDefault(item)) : true;
  const toggle = (id: string) => {
    const item = snap.items.find((i) => i.id === id);
    if (item) setFolds((f) => new Map(f).set(id, !isOpen(item)));
  };
  const spinner = SPINNER[Math.floor(now / SPINNER_MS) % SPINNER.length] ?? "●";
  const lines = Math.min(COMPOSER_MAX_LINES, Math.max(1, text.split("\n").length));
  const v = s.validation;
  const badge =
    v.state === "validating"
      ? { text: `${spinner} checking`, fg: color.warn }
      : v.state === "failed"
        ? { text: `✗ ${v.failed ? STAGE_LABELS[v.failed] : "failed"}`, fg: color.danger }
        : v.state === "passed"
          ? { text: "✓", fg: color.ok }
          : { text: "", fg: color.muted };
  const shown = s.preview;
  // What the preview shows: a revision, or a draft of the turn under way.
  const label = shown ? (shown.draft ? "draft" : `r${shown.revision}`) : "app";
  const drafting =
    s.draft === "building"
      ? ` · ${spinner} draft`
      : s.draft === "waiting"
        ? " · draft · waiting for a build that works"
        : "";
  const frameColor = ended
    ? color.danger
    : v.state === "failed"
      ? color.warn
      : pane === "preview"
        ? color.accent
        : color.border;

  const chat = (
    <box id="studio-chat" flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0}>
      <Transcript
        items={snap.items}
        isOpen={isOpen}
        selected={null}
        now={now}
        wide={false}
        sticky={sticky}
        onToggle={toggle}
        onLink={() => {}}
        cwd={s.project.directory}
        scroll={scroll}
        empty={<Empty snap={snap} studio={s} />}
      />
      <box
        id="studio-composer"
        height={lines + 2}
        flexShrink={0}
        flexDirection="row"
        border
        borderStyle="rounded"
        borderColor={composing ? color.accentDim : color.border}
        paddingX={1}
      >
        <text width={2} flexShrink={0} fg={composing ? color.accent : color.faint}>
          ›
        </text>
        <box flexGrow={1}>
          <Textarea
            ref={field}
            name="studio/prompt"
            focused={composing}
            value={text}
            onChange={setText}
            onSubmit={() => void submit()}
            keyBindings={[...COMPOSER_KEYS]}
            placeholder={
              busy ? "The harness is working… (Esc interrupts)" : "Describe the app, or a change…"
            }
            textColor={color.text}
            focusedTextColor={color.text}
            placeholderColor={color.faint}
          />
        </box>
      </box>
      <box height={1} flexShrink={0} flexDirection="row" paddingX={1}>
        {message ? (
          <text wrapMode="none" truncate fg={message.fg}>
            {message.text}
          </text>
        ) : (
          <StatusLine snap={snap} />
        )}
      </box>
    </box>
  );

  const preview = (
    <box
      id="studio-preview"
      flexDirection="column"
      flexGrow={1}
      flexBasis={0}
      minWidth={0}
      border
      borderStyle="rounded"
      borderColor={frameColor}
      title={` ${label} · ${shown?.mode ?? "no preview"}${drafting}${
        ended ? ` · ended (${ended.code ?? "signal"})` : ""
      } `}
      onMouseDown={() => setPane("preview")}
    >
      {s.warning ? (
        <text height={1} flexShrink={0} wrapMode="none" truncate fg={color.warn}>
          ⚠ {s.warning}
        </text>
      ) : null}
      {shown && !ended ? (
        <Preview
          key={shown.id}
          preview={shown}
          label={label}
          active={pane === "preview" && !panel && !request}
          prefix={PREFIX}
          onFailure={(r, path, why) =>
            shown.draft ? undefined : void previewFailed(r, path, why).catch(() => {})
          }
          onExit={(code) => setExited({ id: shown.id, code })}
        />
      ) : (
        <box flexDirection="column" padding={1}>
          <Line fg={s.previewError ? color.danger : color.muted}>
            {s.previewError ??
              (ended
                ? `The app ended (code ${ended.code ?? "signal"}): Ctrl+O r restarts it.`
                : v.state === "failed"
                  ? "No revision runs yet: see the conversation."
                  : `${spinner} Building the app…`)}
          </Line>
        </box>
      )}
    </box>
  );

  return (
    <box id="studio" flexDirection="column" flexGrow={1}>
      <box id="studio-header" height={1} flexShrink={0} flexDirection="row">
        <text flexShrink={0} fg={busy ? color.warn : color.accent}>
          {busy ? spinner : "●"} studio
        </text>
        <text flexGrow={1} flexShrink={1} wrapMode="none" truncate fg={color.muted}>
          {` · ${s.project.name} · powered by ${snap.info.poweredBy}${
            shown ? ` · ${shown.draft ? `draft over r${shown.revision}` : label}` : ""
          }${v.fixes ? ` · correction ${v.fixes}/${v.maxFixes}` : ""}`}
        </text>
        <text id="studio-validation" flexShrink={0} fg={badge.fg}>
          {badge.text}
        </text>
      </box>
      <box flexDirection="row" flexGrow={1} gap={1}>
        {sideBySide ? (
          <>
            {chat}
            {preview}
          </>
        ) : pane === "chat" && !full ? (
          chat
        ) : (
          preview
        )}
      </box>
      {panel?.kind === "revisions" ? (
        <Picker
          title="Revisions"
          items={s.revisions.slice(0, REVISIONS_SHOWN).map((r) => ({
            id: String(r.number),
            label: `r${r.number} · ${r.summary}`,
            detail: [new Date(r.at).toLocaleTimeString(), r.problem ? `⚠ ${r.problem}` : ""]
              .filter(Boolean)
              .join(" · "),
            current: r.number === revision,
          }))}
          onPick={(item) => {
            setPanel(null);
            void run("Restore", () => restore(Number(item.id)));
          }}
          onClose={() => setPanel(null)}
        />
      ) : panel?.kind === "diff" ? (
        <Overlay
          title={`r${panel.revision}: what changed`}
          rows={DIFF_ROWS}
          footer={<Line fg={color.muted}>Esc closes</Line>}
        >
          <scrollbox flexGrow={1} scrollY>
            {panel.error ? (
              <Line fg={color.danger}>{panel.error}</Line>
            ) : !panel.files ? (
              <Line fg={color.muted}>Loading…</Line>
            ) : panel.files.length === 0 ? (
              <Line fg={color.muted}>No file changed.</Line>
            ) : (
              panel.files.map((file) => (
                <Patch key={file.path} patch={file.patch} path={file.path} wide={false} />
              ))
            )}
          </scrollbox>
        </Overlay>
      ) : request ? (
        <RequestDialog
          key={request.id}
          request={request}
          wide={false}
          onRespond={(response) => void answer(request, response)}
          onCancel={() =>
            void answer(
              request,
              request.kind === "approval"
                ? { kind: "approval", decision: "deny" }
                : { kind: "cancel" },
            )
          }
        />
      ) : null}
    </box>
  );
}

function Empty({ snap, studio }: { snap: Snapshot; studio: StudioSnapshot }) {
  return (
    <box flexDirection="column" paddingY={1}>
      <Line fg={color.text}>Describe the app you want; it runs on the right as it is written.</Line>
      <Line fg={color.muted}>
        {snap.state === "starting"
          ? `Starting ${snap.info.poweredBy}…`
          : snap.state === "stopped" && snap.error
            ? snap.error
            : `${snap.info.poweredBy} writes ${studio.project.directory}.`}
      </Line>
      <Line fg={color.faint}>
        Ctrl+O o switches to the app · Ctrl+O u undoes · Ctrl+O h lists revisions
      </Line>
    </box>
  );
}
