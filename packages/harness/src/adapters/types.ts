import type {
  Capabilities,
  CommandInfo,
  HarnessId,
  Info,
  Item,
  Mode,
  ModelInfo,
  PlanStep,
  Request,
  Response,
  SessionSummary,
  Usage,
} from "../model";

/**
 * What a harness tells the session, whatever its protocol (spec §4.2). Items are sent
 * whole when they start and when they complete (`completed` is authoritative); deltas
 * in between only append text.
 */
export type HarnessEvent =
  | { type: "turn.started" }
  | { type: "turn.completed"; status: "completed" | "interrupted" | "failed"; error?: string }
  | { type: "item.started"; item: Item }
  | { type: "item.delta"; id: string; field: "text" | "output"; delta: string }
  | { type: "item.completed"; item: Item }
  /** The transcript of a resumed session, replacing the current one. */
  | { type: "history"; items: readonly Item[] }
  | { type: "plan.updated"; steps: readonly PlanStep[] }
  | { type: "request.opened"; request: Request }
  | { type: "request.resolved"; id: string }
  | { type: "usage.updated"; usage: Usage }
  | { type: "info.updated"; info: Partial<Omit<Info, "harness" | "cwd">> }
  | { type: "queue.updated"; queued: readonly string[] }
  | { type: "notice"; level: "info" | "warn" | "error"; text: string }
  /** The harness process ended: the session can start it again. */
  | { type: "exited"; reason: string };

export type UserInput = { text: string };

export type StartOptions = {
  cwd: string;
  mode: Mode;
  model?: string;
  effort?: string;
  /** A harness session to resume: its id, or `true` for the latest of `cwd`. */
  resume?: string | true;
  /** Who drives the harness, as it is told (Codex `clientInfo`, the Agent SDK's client app). */
  client?: string;
  /**
   * Added to the harness's own system instructions (Claude: `systemPrompt.append`;
   * Codex: `developerInstructions`); pi and opencode ignore it.
   */
  instructions?: string;
  /** The only built-in tools the harness may use (Claude: `tools`); others ignore it. */
  tools?: readonly string[];
  /**
   * The user's own harness settings stay out of this session (Claude: no user, project or
   * local settings: no hooks, MCP servers or CLAUDE.md of theirs).
   */
  isolated?: boolean;
};

/** What a harness adapter is given: where to report, and the process environment. */
export type HarnessContext = {
  emit: (event: HarnessEvent) => void;
  env: NodeJS.ProcessEnv;
};

/**
 * One harness session (spec §4.1). Methods resolve once the harness took the command
 * into account, never at the end of a turn: progress comes as events. A method a
 * capability does not announce is never called.
 */
export interface Harness {
  readonly id: HarnessId;
  readonly capabilities: Capabilities;
  /** Starts the harness (or resumes a session); resolves once it accepts prompts. */
  start(options: StartOptions): Promise<void>;
  send(input: UserInput): Promise<void>;
  /** Adds to the running turn (capability `steer`). */
  steer(input: UserInput): Promise<void>;
  interrupt(): Promise<void>;
  /** Answers a request the harness opened; called once per request. */
  respond(request: Request, response: Response): Promise<void>;
  setModel(model: string, effort?: string): Promise<void>;
  setMode(mode: Mode): Promise<void>;
  compact(): Promise<void>;
  newSession(): Promise<void>;
  resume(id: string): Promise<void>;
  listSessions(): Promise<readonly SessionSummary[]>;
  models(): Promise<readonly ModelInfo[]>;
  commands(): Promise<readonly CommandInfo[]>;
  close(): Promise<void>;
}

/** Whether a harness can be used here, found without asking a model anything. */
export type HarnessStatus = {
  id: HarnessId;
  installed: boolean;
  version?: string;
  ready: boolean;
  /** Who is signed in, as the harness says (never a secret). */
  account?: string;
  /** What to run when it is not ready: "claude auth login", "install codex". */
  fix?: string;
  warnings: readonly string[];
};
