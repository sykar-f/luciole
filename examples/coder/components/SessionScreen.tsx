"use client";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import {
  useBlur,
  useFocus,
  useRenderer,
  useSelectionHandler,
  useTerminalDimensions,
} from "@opentui/react";
import {
  Textarea,
  TransportError,
  host,
  useBindings,
  useConnection,
  useLive,
  useRestoredFields,
} from "luciole/client";
import {
  compact,
  feed,
  files,
  interrupt,
  listSessions,
  newSession,
  requestState,
  respond,
  resume,
  send,
  setEffort,
  setMode,
  setModel,
} from "../actions/session";
import { Completion, COMPLETION_ROWS, type Suggestion } from "./Completion";
import { Overlay, RequestDialog } from "@luciole/harness/ui/Dialogs";
import { editText } from "./editor";
import { Frame } from "@luciole/harness/ui/Frame";
import { Line } from "@luciole/harness/ui/Line";
import {
  HARNESS_NAMES,
  MODE_LABELS,
  type Item,
  type Mode,
  type Request,
  type Response,
  type Result,
  type SessionSummary,
  type Snapshot,
} from "@luciole/harness/model";
import { Picker, type PickerItem } from "@luciole/harness/ui/Picker";
import { PlanBar, StatusLine } from "@luciole/harness/ui/StatusLine";
import { FeedStore } from "@luciole/harness/ui/store";
import { color } from "@luciole/harness/ui/theme";
import { foldable, itemId, openByDefault, Transcript } from "@luciole/harness/ui/Transcript";

const SPINNER = "◐◓◑◒";
// Slow on purpose: every frame walks the whole tree (OpenTUI #1339).
const SPINNER_MS = 250;
// Updates kept by the live hook between two renders: far more than 50 ms can bring.
const LIVE_LIMIT = 200;
// The composer grows with its text up to this many lines, then scrolls.
const COMPOSER_MAX_LINES = 8;
// Borders, the prompt glyph and padding around the composer's text.
const COMPOSER_CHROME = 7;
// Rows under the transcript that the completion popup sits above: status line.
const STATUS_ROWS = 1;
// The diff is split in two columns from this width on.
const SPLIT_COLUMNS = 140;
const PAGE_ROWS = 10;
const FILES_DEBOUNCE_MS = 120;
const MESSAGE_MS = 5000;
const COST_DECIMALS = 4;
// The help's fixed lines, and an overlay footer's (its border, one line).
const HELP_ROWS = 6;
const OVERLAY_FOOTER_ROWS = 2;
const LABEL_WIDTH = 10;

// Enter sends; Shift+Enter or Ctrl+J add a line (Alt+Enter queues, see the bindings).
const COMPOSER_KEYS = [
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "linefeed", action: "newline" },
] as const;

type Message = { text: string; fg: string };
type Panel =
  | { kind: "model" }
  | { kind: "effort"; model: string }
  | { kind: "mode" }
  | { kind: "resume"; sessions?: readonly SessionSummary[]; error?: string }
  | { kind: "commands" }
  | { kind: "status" }
  | { kind: "help" };
type AppCommand = {
  name: string;
  description: string;
  available: (snap: Snapshot) => boolean;
  run: (rest: string) => void;
};

const failure = (error: unknown) =>
  error instanceof TransportError
    ? `${error.message} (${error.outcome})`
    : error instanceof Error
      ? error.message
      : "Request failed";
const nextMode = (modes: readonly Mode[], mode: Mode) =>
  modes[(modes.indexOf(mode) + 1) % modes.length] ?? mode;
const textOf = (item: Item) => {
  switch (item.kind) {
    case "user":
    case "message":
    case "reasoning":
      return item.text;
    case "command":
      return `$ ${item.command}\n${item.output}`;
    case "file_change":
      return item.files.map((f) => f.patch).join("\n");
    case "tool":
      return `${item.name} ${item.input}\n${item.output}`;
    case "subagent":
      return `${item.title}\n${item.detail}`;
    case "compaction":
      return "context compacted";
    case "notice":
      return item.text;
  }
};

/**
 * The session screen. What it shows comes from one live subscription (`feed`): a
 * snapshot, then patches. The prompt, folds, selection and overlays are local; every
 * change to the session is a Server Function that answers at once.
 */
export function SessionScreen({ initial }: { initial: Snapshot }) {
  const [attempt, setAttempt] = useState(0);
  const live = useLive(feed, [attempt], { limit: LIVE_LIMIT });
  const [store] = useState(() => new FeedStore(initial));
  useEffect(() => {
    // A missing update: a new subscription starts again from a snapshot.
    store.follow(attempt, live.items, () => setAttempt((n) => n + 1));
  }, [store, attempt, live.items]);
  const snap = useSyncExternalStore(store.subscribe, store.get);
  const { refresh } = useConnection();
  const renderer = useRenderer();
  const { width } = useTerminalDimensions();
  const fields = useRestoredFields("coder");
  const field = useRef<TextareaRenderable>(null);
  const scroll = useRef<ScrollBoxRenderable>(null);

  const [text, setText] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [folds, setFolds] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [selected, setSelected] = useState<string | null>(null);
  const [sticky, setSticky] = useState(true);
  const [message, setMessage] = useState<Message | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [answering, setAnswering] = useState<ReadonlySet<string>>(new Set());
  const [dialogMessage, setDialogMessage] = useState<Message | undefined>();
  const [cursor, setCursor] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [found, setFound] = useState<{ query: string; files: readonly string[] }>({
    query: "",
    files: [],
  });
  const focused = useRef(true);
  useFocus(() => void (focused.current = true));
  useBlur(() => void (focused.current = false));

  const busy = snap.state === "running" || snap.state === "interrupting";
  const lost = live.done;
  const request = snap.requests.find((r) => !answering.has(r.id));
  const wide = width >= SPLIT_COLUMNS;
  const composing = !browsing && !panel && !request;
  const say = (text: string, fg: string = color.muted) => setMessage({ text, fg });

  // The spinner and running items' clocks tick locally, only while a turn runs.
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setNow(Date.now()), SPINNER_MS);
    return () => clearInterval(timer);
  }, [busy]);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), MESSAGE_MS);
    return () => clearTimeout(timer);
  }, [message]);
  // A request waits for the user: the OS says so when the terminal is not in front.
  const requestId = snap.requests[0]?.id;
  useEffect(() => {
    if (!requestId || focused.current) return;
    void host
      .notify({ title: "coder", body: `${HARNESS_NAMES[snap.info.harness]} is waiting for you` })
      .catch(() => {});
  }, [requestId, snap.info.harness]);
  // A mouse selection is copied as it ends (OSC 52: works over ssh too).
  useSelectionHandler((selection) => {
    if (selection.isDragging) return;
    const selectedText = selection.getSelectedText();
    if (selectedText && renderer.copyToClipboardOSC52(selectedText)) say("Copied the selection");
  });

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

  const toBottom = () => {
    setSticky(true);
    scroll.current?.scrollTo(scroll.current.scrollHeight);
  };
  const clearComposer = () => {
    field.current?.setText("");
    setText("");
    setDismissed(null);
  };

  async function submit(queue = false) {
    const value = (field.current?.plainText ?? text).trim();
    if (!value) return;
    if (value.startsWith("/")) {
      const [name = "", ...rest] = value.slice(1).split(/\s+/);
      const command = appCommands.find((c) => c.name === name && c.available(snap));
      if (command) {
        clearComposer();
        fields.clear();
        command.run(rest.join(" "));
        return;
      }
    }
    clearComposer();
    toBottom();
    // Forgotten while the request runs, kept again if it never reached the Server.
    const sent = await run(busy && !queue ? "Steer" : "Send", () =>
      fields.submit(() => send(value, queue), { failed: (r) => !r.ok }),
    );
    if (!sent) setText((current) => current || value);
    else if (busy)
      say(
        queue || !snap.capabilities.steer
          ? "Queued for the end of the turn"
          : "Sent to the running turn",
      );
  }

  async function answer(target: Request, response: Response) {
    setAnswering((ids) => new Set(ids).add(target.id));
    setDialogMessage(undefined);
    const reopen = (text: string) => {
      setAnswering((ids) => {
        const next = new Set(ids);
        next.delete(target.id);
        return next;
      });
      setDialogMessage({ text, fg: color.danger });
    };
    try {
      const result = await respond(target.id, response);
      if (!result.ok) reopen(result.error);
    } catch (error: unknown) {
      if (!(error instanceof TransportError) || error.outcome !== "unknown")
        return reopen(`Not sent: ${failure(error)}`);
      // It may have reached the harness: never answered twice, looked up instead.
      const state = await requestState(target.id).catch(() => undefined);
      if (!state)
        reopen("The answer's outcome is unknown and the Server does not answer: try again");
      else if (state.state === "pending") reopen("The answer did not arrive: answer again");
    }
  }
  const cancel = (target: Request) => {
    void answer(
      target,
      target.kind === "approval" ? { kind: "approval", decision: "deny" } : { kind: "cancel" },
    );
    void run("Interrupt", interrupt);
  };

  const appCommands = useMemo(
    (): readonly AppCommand[] => [
      {
        name: "new",
        description: "Start a new session",
        available: (s) => s.capabilities.newSession,
        run: startNew,
      },
      {
        name: "resume",
        description: "Resume a session of this project",
        available: (s) => s.capabilities.resume,
        run: (id) => (id ? void run("Resume", () => resume(id)) : openResume()),
      },
      {
        name: "model",
        description: "Choose the model",
        available: (s) => s.capabilities.models,
        run: () => setPanel({ kind: "model" }),
      },
      {
        name: "effort",
        description: "Choose the reasoning effort",
        available: (s) => s.capabilities.effort && !!currentModel(s)?.efforts.length,
        run: (effort) =>
          effort
            ? void run("Effort", () => setEffort(effort))
            : setPanel({ kind: "effort", model: snap.info.model ?? "" }),
      },
      {
        name: "mode",
        description: "Choose the permission mode",
        available: (s) => s.capabilities.modes.length > 1,
        run: () => setPanel({ kind: "mode" }),
      },
      {
        name: "plan",
        description: "Plan first: read-only until a plan is approved",
        available: (s) => s.capabilities.planMode && s.capabilities.modes.includes("read"),
        run: () => void run("Plan mode", () => setMode("read")),
      },
      {
        name: "compact",
        description: "Compact the context",
        available: (s) => s.capabilities.compact,
        run: () => void run("Compact", compact),
      },
      {
        name: "status",
        description: "Harness, account, versions, usage",
        available: () => true,
        run: () => setPanel({ kind: "status" }),
      },
      {
        name: "help",
        description: "Keys and commands",
        available: () => true,
        run: () => setPanel({ kind: "help" }),
      },
    ],
    // Commands read the latest snapshot when run; the list only depends on it for `effort`.
    [snap],
  );

  function currentModel(s: Snapshot) {
    return s.models.find((m) => m.id === s.info.model);
  }
  function startNew() {
    setFolds(new Map());
    setSelected(null);
    setBrowsing(false);
    void run("New session", newSession);
  }
  function openResume() {
    setPanel({ kind: "resume" });
    void listSessions().then(
      (result) =>
        setPanel((p) =>
          p?.kind === "resume"
            ? result.ok
              ? { kind: "resume", sessions: result.sessions }
              : { kind: "resume", error: result.error }
            : p,
        ),
      (error: unknown) =>
        setPanel((p) => (p?.kind === "resume" ? { kind: "resume", error: failure(error) } : p)),
    );
  }
  async function editInEditor() {
    const edited = await editText(renderer, field.current?.plainText ?? text);
    setText(edited);
  }

  // Completion of the word being typed: `/command` at the start, `@file` anywhere.
  const slash = /^\/(\S*)$/.exec(text)?.[1];
  const at = /(?:^|\s)@(\S*)$/.exec(text)?.[1];
  useEffect(() => {
    if (at === undefined || at === found.query) return;
    const timer = setTimeout(() => {
      void files(at).then(
        (list) => setFound({ query: at, files: list }),
        () => {},
      );
    }, FILES_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [at, found.query]);
  const suggestions: readonly Suggestion[] =
    !composing || dismissed === text
      ? []
      : slash !== undefined
        ? [
            ...appCommands
              .filter((c) => c.available(snap))
              .map((c) => ({ name: c.name, description: c.description })),
            ...snap.commands,
          ]
            .filter((c) => c.name.startsWith(slash) && `/${c.name}` !== text)
            .map((c) => ({ value: `/${c.name} `, label: `/${c.name}`, detail: c.description }))
        : at !== undefined && found.query === at
          ? found.files.map((file) => ({ value: file, label: `@${file}` }))
          : [];
  const pick = (suggestion: Suggestion | undefined) => {
    if (!suggestion) return;
    const next =
      slash !== undefined ? suggestion.value : text.replace(/@(\S*)$/, `@${suggestion.value} `);
    setText(next);
    setCursor(0);
  };

  const isOpen = (item: Item) => folds.get(item.id) ?? openByDefault(item);
  const foldIds = snap.items.filter(foldable).map((i) => i.id);
  // A link clicked in a reply opens in the browser; the host only opens http(s) URLs.
  function openLink(url: string) {
    host.openUrl(url).then(
      () => say(`Opened ${url}`),
      () => say(`Could not open ${url}`, color.warn),
    );
  }

  function toggle(id: string) {
    setSelected(id);
    // Unfolding or folding should not drag a reader who scrolled up to the bottom (#1514).
    setSticky(false);
    setFolds((current) => {
      const item = snap.items.find((i) => i.id === id);
      if (!item) return current;
      // From the latest folds, not the ones this binding was created with.
      return new Map(current).set(id, !(current.get(id) ?? openByDefault(item)));
    });
  }
  function select(delta: number) {
    if (!foldIds.length) return;
    const index = selected ? foldIds.indexOf(selected) : -1;
    const start = index < 0 ? (delta > 0 ? -1 : foldIds.length) : index;
    const next = foldIds[Math.max(0, Math.min(foldIds.length - 1, start + delta))] ?? null;
    setSelected(next);
    setSticky(false);
    if (next) scroll.current?.scrollChildIntoView(itemId(next));
  }
  function browse() {
    setBrowsing(true);
    if (!selected || !foldIds.includes(selected)) {
      const last = foldIds.at(-1) ?? null;
      setSelected(last);
      if (last) scroll.current?.scrollChildIntoView(itemId(last));
    }
  }
  const page = (rows: number) => {
    if (rows < 0) setSticky(false);
    scroll.current?.scrollBy(rows);
  };

  useBindings(
    () => ({
      bindings: [
        {
          key: "ctrl+r",
          cmd: () => {
            // A closed feed does not come back by itself: a new argument reopens it.
            if (lost) setAttempt((n) => n + 1);
            void refresh();
          },
          ...(lost ? { desc: "reconnect", group: "global" } : {}),
        },
        { key: "pageup", cmd: () => page(-PAGE_ROWS), desc: "scroll", group: "global" },
        { key: "pagedown", cmd: () => page(PAGE_ROWS) },
        { key: "end", cmd: toBottom },
        ...(composing
          ? [
              ...(suggestions.length
                ? [
                    {
                      key: "down",
                      cmd: () =>
                        setCursor((c) =>
                          Math.min(Math.min(suggestions.length, COMPLETION_ROWS) - 1, c + 1),
                        ),
                    },
                    { key: "up", cmd: () => setCursor((c) => Math.max(0, c - 1)) },
                    {
                      key: "tab",
                      cmd: () => pick(suggestions[cursor]),
                      desc: "complete",
                      group: "coder",
                    },
                    { key: "return", cmd: () => pick(suggestions[cursor]) },
                    { key: "escape", cmd: () => setDismissed(text) },
                  ]
                : [
                    ...(busy
                      ? [
                          {
                            key: "escape",
                            cmd: () => void run("Interrupt", interrupt),
                            desc: "interrupt",
                            group: "coder",
                          },
                        ]
                      : []),
                    {
                      key: "meta+return",
                      cmd: () => void submit(true),
                      desc: busy ? "queue" : undefined,
                      group: "coder",
                    },
                  ]),
              ...(snap.capabilities.modes.length > 1
                ? [
                    {
                      key: "shift+tab",
                      cmd: () =>
                        void run("Mode", () =>
                          setMode(nextMode(snap.capabilities.modes, snap.info.mode)),
                        ),
                      desc: "mode",
                      group: "coder",
                    },
                  ]
                : []),
              { key: "ctrl+g", cmd: () => void editInEditor(), desc: "editor", group: "coder" },
              ...(foldIds.length
                ? [{ key: "ctrl+o", cmd: browse, desc: "browse", group: "coder" }]
                : []),
            ]
          : []),
        ...(browsing && !panel && !request
          ? [
              { key: "j", cmd: () => select(1), desc: "select", group: "browse" },
              { key: "k", cmd: () => select(-1) },
              { key: "down", cmd: () => select(1) },
              { key: "up", cmd: () => select(-1) },
              ...(selected
                ? [
                    { key: "return", cmd: () => toggle(selected), desc: "fold", group: "browse" },
                    { key: "space", cmd: () => toggle(selected) },
                    {
                      key: "y",
                      cmd: () => {
                        const item = snap.items.find((i) => i.id === selected);
                        if (item && renderer.copyToClipboardOSC52(textOf(item)))
                          say("Copied the block");
                      },
                      desc: "copy",
                      group: "browse",
                    },
                  ]
                : []),
              {
                key: "a",
                cmd: () =>
                  setFolds(() => {
                    const open = !foldIds.every((id) => {
                      const item = snap.items.find((i) => i.id === id);
                      return item ? isOpen(item) : true;
                    });
                    return new Map(foldIds.map((id) => [id, open]));
                  }),
                desc: "fold all",
                group: "browse",
              },
              {
                key: "g",
                cmd: () => {
                  setSticky(false);
                  scroll.current?.scrollTo(0);
                },
                desc: "top",
                group: "browse",
              },
              { key: "shift+g", cmd: toBottom, desc: "bottom", group: "browse" },
              { key: "i", cmd: () => setBrowsing(false), desc: "prompt", group: "browse" },
              { key: "escape", cmd: () => setBrowsing(false) },
            ]
          : []),
      ],
    }),
    [
      composing,
      browsing,
      panel,
      request,
      busy,
      lost,
      selected,
      foldIds.join(),
      suggestions.length,
      cursor,
      text,
      snap,
    ],
  );

  const spinner = SPINNER[Math.floor(now / SPINNER_MS) % SPINNER.length];
  const stateText =
    snap.state === "starting"
      ? { text: `starting ${snap.info.poweredBy}…`, fg: color.warn }
      : snap.state === "stopped"
        ? { text: "stopped", fg: color.danger }
        : snap.state === "interrupting"
          ? { text: "interrupting…", fg: color.danger }
          : null;
  const status: Message | undefined = lost
    ? { text: "Live feed closed · Ctrl+R reconnects", fg: color.danger }
    : (message ??
      (snap.error ? { text: snap.error, fg: color.danger } : undefined) ??
      (snap.queued.length
        ? { text: `${snap.queued.length} queued for the end of the turn`, fg: color.info }
        : undefined) ??
      (snap.info.warnings[0] ? { text: snap.info.warnings[0], fg: color.warn } : undefined));
  const columns = Math.max(1, width - COMPOSER_CHROME);
  const lines = text
    .split("\n")
    .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / columns)), 0);
  const composerHeight = Math.min(COMPOSER_MAX_LINES, Math.max(1, lines));

  return (
    <Frame
      header={
        <>
          <text flexShrink={0} fg={busy ? color.warn : color.accent}>
            {busy ? spinner : "●"} {snap.info.harness}
          </text>
          <text flexGrow={1} flexShrink={1} wrapMode="none" truncate fg={color.muted}>
            {" · "}
            {snap.info.cwd}
            {snap.info.title ? ` · ${snap.info.title}` : ""}
          </text>
          {stateText ? (
            <text flexShrink={0} fg={stateText.fg}>
              {" "}
              {stateText.text}
            </text>
          ) : null}
        </>
      }
      plan={snap.plan.length ? <PlanBar steps={snap.plan} /> : undefined}
      composerHeight={composerHeight}
      composerFocused={composing}
      composerTitle={
        busy
          ? snap.capabilities.steer
            ? " Enter steers · Alt+Enter queues "
            : " Enter queues "
          : undefined
      }
      composer={
        <Textarea
          ref={field}
          name="coder/prompt"
          focused={composing}
          value={text}
          onChange={(value) => {
            setText(value);
            setCursor(0);
          }}
          onSubmit={() => void submit()}
          keyBindings={[...COMPOSER_KEYS]}
          placeholder={
            snap.state === "stopped"
              ? "The harness stopped: Enter starts it again"
              : "Message… (/ commands, @ files)"
          }
          textColor={color.text}
          focusedTextColor={color.text}
          placeholderColor={color.faint}
        />
      }
      status={<StatusLine snap={snap} message={status} />}
      overlay={
        <>
          {composing && suggestions.length ? (
            <Completion
              suggestions={suggestions}
              cursor={cursor}
              bottom={composerHeight + 2 + STATUS_ROWS}
              onPick={pick}
            />
          ) : null}
          {panel ? (
            <PanelView
              panel={panel}
              snap={snap}
              commands={appCommands}
              close={() => setPanel(null)}
              run={run}
            />
          ) : request ? (
            <RequestDialog
              key={request.id}
              request={request}
              wide={wide}
              message={dialogMessage}
              onRespond={(response) => void answer(request, response)}
              onCancel={() => cancel(request)}
            />
          ) : null}
        </>
      }
    >
      <Transcript
        items={snap.items}
        isOpen={isOpen}
        selected={browsing ? selected : null}
        now={now}
        wide={wide}
        sticky={sticky}
        onToggle={toggle}
        onLink={openLink}
        cwd={snap.info.cwd}
        scroll={scroll}
        empty={<Empty snap={snap} />}
      />
    </Frame>
  );
}

function Empty({ snap }: { snap: Snapshot }) {
  return (
    <box flexDirection="column" paddingY={1}>
      <Line fg={color.muted}>
        {snap.state === "starting"
          ? `Starting ${snap.info.poweredBy}…`
          : `${snap.info.poweredBy} is ready in ${snap.info.cwd}.`}
      </Line>
      {snap.info.harness === "fake" ? (
        <Line fg={color.faint}>
          Scripted demo: try « run the tests », « edit greet », « plan », « question », « slow ».
        </Line>
      ) : (
        <Line fg={color.faint}>
          Ask anything; / lists commands, @ inserts a file, Ctrl+G opens $EDITOR.
        </Line>
      )}
    </box>
  );
}

function PanelView({
  panel,
  snap,
  commands,
  close,
  run,
}: {
  panel: Panel;
  snap: Snapshot;
  commands: readonly AppCommand[];
  close: () => void;
  run: (label: string, call: () => Promise<Result>) => Promise<boolean>;
}) {
  switch (panel.kind) {
    case "model":
      return (
        <Picker
          title="Model"
          items={snap.models.map((m) => ({
            id: m.id,
            label: m.label,
            detail: m.efforts.length ? `effort ${m.efforts.join("/")}` : m.id,
            blocked: m.blocked,
            current: m.id === snap.info.model,
          }))}
          onClose={close}
          onPick={(item) => {
            close();
            void run("Model", () => setModel(item.id, undefined));
          }}
        />
      );
    case "effort": {
      const model =
        snap.models.find((m) => m.id === panel.model) ??
        snap.models.find((m) => m.id === snap.info.model);
      return (
        <Picker
          title={`Effort · ${model?.label ?? "model"}`}
          items={(model?.efforts ?? []).map((e) => ({
            id: e,
            label: e,
            current: e === snap.info.effort,
          }))}
          onClose={close}
          onPick={(item) => {
            close();
            void run("Effort", () => setEffort(item.id));
          }}
        />
      );
    }
    case "mode":
      return (
        <Picker
          title="Permission mode"
          items={snap.capabilities.modes.map((m) => ({
            id: m,
            label: MODE_LABELS[m],
            current: m === snap.info.mode,
          }))}
          onClose={close}
          onPick={(item) => {
            close();
            void run("Mode", () => setMode(item.id));
          }}
        />
      );
    case "resume":
      return (
        <Picker
          title="Resume a session"
          loading={!panel.sessions && !panel.error}
          error={panel.error}
          items={(panel.sessions ?? []).map((s): PickerItem => ({
            id: s.id,
            label: s.title || s.id,
            detail: new Date(s.updatedAt).toLocaleString(),
            current: s.id === snap.info.sessionId,
          }))}
          onClose={close}
          onPick={(item) => {
            close();
            void run("Resume", () => resume(item.id));
          }}
        />
      );
    case "commands":
    case "help":
      return <HelpView snap={snap} commands={commands} close={close} />;
    case "status":
      return <StatusView snap={snap} close={close} />;
  }
}

function HelpView({
  snap,
  commands,
  close,
}: {
  snap: Snapshot;
  commands: readonly AppCommand[];
  close: () => void;
}) {
  useBindings(
    () => ({ bindings: [{ key: "escape", cmd: close, desc: "close", group: "picker" }] }),
    [close],
  );
  const all = [
    ...commands
      .filter((c) => c.available(snap))
      .map((c) => ({ name: c.name, description: c.description })),
    ...snap.commands,
  ];
  return (
    <Overlay
      title="Help"
      rows={HELP_ROWS + all.length + OVERLAY_FOOTER_ROWS}
      footer={<Line fg={color.muted}>Esc close</Line>}
    >
      <Line fg={color.accent}>Keys</Line>
      <Line fg={color.muted}>
        {" "}
        Enter send · Shift+Enter / Ctrl+J new line · Alt+Enter queue · Esc interrupt
      </Line>
      <Line fg={color.muted}>
        {" "}
        Shift+Tab mode · Ctrl+G $EDITOR · Ctrl+O browse (j/k, Enter fold, y copy, g/G)
      </Line>
      <Line fg={color.muted}> PgUp/PgDn scroll · End follow · Ctrl+R reconnect · Ctrl+C quit</Line>
      <Line />
      <Line fg={color.accent}>Commands</Line>
      <scrollbox flexShrink={1} scrollY>
        {all.map((c) => (
          <Line key={c.name} fg={color.muted}>
            {" "}
            <span fg={color.text}>/{c.name}</span> {c.description}
          </Line>
        ))}
      </scrollbox>
    </Overlay>
  );
}

function StatusView({ snap, close }: { snap: Snapshot; close: () => void }) {
  useBindings(
    () => ({ bindings: [{ key: "escape", cmd: close, desc: "close", group: "picker" }] }),
    [close],
  );
  const { info, usage } = snap;
  const rows: [string, string | undefined][] = [
    ["Harness", `${HARNESS_NAMES[info.harness]}${info.version ? ` ${info.version}` : ""}`],
    ["Account", info.account],
    ["Directory", info.cwd],
    ["Session", info.sessionId],
    ["Model", info.model ? `${info.model}${info.effort ? ` · ${info.effort}` : ""}` : undefined],
    ["Mode", MODE_LABELS[info.mode]],
    [
      "Context",
      usage.context ? `${usage.context.used} / ${usage.context.window} tokens` : undefined,
    ],
    [
      "Cost",
      usage.costUsd !== undefined
        ? `$${usage.costUsd.toFixed(COST_DECIMALS)} (as the harness reports it)`
        : undefined,
    ],
  ];
  return (
    <Overlay
      title="Status"
      rows={rows.length + info.warnings.length + 1 + OVERLAY_FOOTER_ROWS}
      footer={<Line fg={color.muted}>Esc close</Line>}
    >
      {rows
        .filter((r): r is [string, string] => r[1] !== undefined)
        .map(([label, value]) => (
          <Line key={label} fg={color.text}>
            <span fg={color.muted}>{label.padEnd(LABEL_WIDTH)}</span>
            {value}
          </Line>
        ))}
      {info.warnings.map((w) => (
        <Line key={w} fg={color.warn}>
          ⚠ {w}
        </Line>
      ))}
      <Line fg={color.faint}>Each harness uses its own login and quota; coder reads no token.</Line>
    </Overlay>
  );
}
