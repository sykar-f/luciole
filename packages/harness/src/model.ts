// What the Server tells the Client about the session, in plain data: every harness is
// translated into this vocabulary (server/adapters), and the Client never learns which
// protocol produced it. Types only, plus the lists both sides validate against.

export const HARNESSES = ["claude", "codex", "pi", "opencode", "fake"] as const;
export type HarnessId = (typeof HARNESSES)[number];
export const HARNESS_NAMES: Record<HarnessId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  pi: "pi",
  opencode: "opencode",
  fake: "scripted demo",
};

/** Permission modes, in the order Shift+Tab walks them. */
export const MODES = ["read", "ask", "edits", "full"] as const;
export type Mode = (typeof MODES)[number];
export const MODE_LABELS: Record<Mode, string> = {
  read: "read only",
  ask: "ask",
  edits: "auto edits",
  full: "full access",
};

export type SessionState = "starting" | "idle" | "running" | "interrupting" | "stopped";
export type ItemStatus = "running" | "done" | "error" | "declined";

type ItemBase = { id: string; startedAt?: number; endedAt?: number };
/** One entry of the transcript. Replaced whole on change, never mutated. */
export type Item = ItemBase &
  (
    | { kind: "user"; text: string; queued?: boolean }
    | { kind: "message"; text: string; streaming: boolean }
    | { kind: "reasoning"; text: string; streaming: boolean }
    | {
        kind: "command";
        command: string;
        cwd?: string;
        output: string;
        exitCode?: number;
        status: ItemStatus;
      }
    | {
        kind: "file_change";
        /** One unified patch per file: OpenTUI's diff shows the first patch only. */
        files: readonly FilePatch[];
        status: ItemStatus;
      }
    | {
        kind: "tool";
        name: string;
        title: string;
        input: string;
        output: string;
        status: ItemStatus;
      }
    | { kind: "subagent"; title: string; detail: string; tools: number; status: ItemStatus }
    | { kind: "compaction"; status: ItemStatus }
    | { kind: "notice"; level: "info" | "warn" | "error"; text: string }
  );
export type ItemKind = Item["kind"];
export type FilePatch = { path: string; patch: string; additions: number; deletions: number };

export type PlanStep = { text: string; status: "pending" | "in_progress" | "completed" };

export type QuestionOption = { label: string; description?: string };
export type Question = {
  question: string;
  header?: string;
  options: readonly QuestionOption[];
  multiple?: boolean;
};

/** How an approval may be answered; each harness offers some of them. */
export type Decision = "once" | "session" | "always" | "deny";
/** Something the agent waits for: answered once, by id (`respond`). */
export type Request = { id: string; openedAt: number } & (
  | {
      kind: "approval";
      title: string;
      /** A command to run, shown as code. */
      command?: string;
      /** File changes, shown as diffs. */
      files?: readonly FilePatch[];
      detail?: string;
      decisions: readonly Decision[];
    }
  | { kind: "question"; questions: readonly Question[] }
  | { kind: "plan_review"; plan: string }
);
export type RequestKind = Request["kind"];

/** The answer to a request, as the dialog sends it. */
export type Response =
  | { kind: "approval"; decision: Decision }
  | { kind: "question"; answers: readonly (readonly string[])[] }
  | { kind: "plan_review"; approve: boolean; feedback?: string }
  | { kind: "cancel" };

export type Usage = {
  /** Context window use, in tokens. */
  context?: { used: number; window: number };
  /** Subscription limits, in percent used, as the harness reports them. */
  limits?: { fiveHour?: number; weekly?: number; resetsAt?: number };
  costUsd?: number;
  tokens?: { input: number; output: number };
};

export type ModelInfo = {
  id: string;
  label: string;
  /** Reasoning efforts this model accepts; none when it has no such setting. */
  efforts: readonly string[];
  defaultEffort?: string;
  /** Why it cannot be picked (a compliance rule, a missing login). */
  blocked?: string;
};
export type CommandInfo = { name: string; description: string; source: "app" | "harness" };
export type SessionSummary = { id: string; title: string; updatedAt: number; cwd?: string };

/** What a harness can do: buttons and commands without a capability do not appear. */
export type Capabilities = {
  steer: boolean;
  models: boolean;
  effort: boolean;
  modes: readonly Mode[];
  compact: boolean;
  resume: boolean;
  newSession: boolean;
  planMode: boolean;
  images: boolean;
};

/** Who the session talks to and how: the status line. */
export type Info = {
  harness: HarnessId;
  /** "powered by …": the harness's own name, text only. */
  poweredBy: string;
  version?: string;
  account?: string;
  model?: string;
  effort?: string;
  mode: Mode;
  cwd: string;
  sessionId?: string;
  title?: string;
  /** Things the user should know once: an API key overriding a subscription, … */
  warnings: readonly string[];
};

export type Snapshot = {
  state: SessionState;
  info: Info;
  items: readonly Item[];
  requests: readonly Request[];
  plan: readonly PlanStep[];
  usage: Usage;
  /** Messages waiting for the end of the turn. */
  queued: readonly string[];
  error: string | null;
  capabilities: Capabilities;
  models: readonly ModelInfo[];
  commands: readonly CommandInfo[];
};
export type Fields = Omit<Snapshot, "items">;

/**
 * What the live feed carries: the whole session once, then only what changed. `seq`
 * counts the updates of one subscription; a Client that sees a gap asks for a new one.
 */
export type Update =
  | { kind: "snapshot"; seq: number; snapshot: Snapshot }
  | {
      kind: "patch";
      seq: number;
      items: readonly Item[];
      removed: readonly string[];
      fields: Partial<Fields>;
    };

/** What an action answers: at once, the rest comes through the feed. */
export type Result = { ok: true } | { ok: false; error: string };
/** Where a request stands, for a Client whose answer's outcome is unknown. */
export type RequestState =
  | { state: "pending" }
  | { state: "answered"; response: Response }
  | { state: "gone" };
