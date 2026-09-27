import type {
  Capabilities,
  CommandInfo,
  FilePatch,
  Item,
  ItemStatus,
  Mode,
  ModelInfo,
  PlanStep,
  Request,
  Response,
  SessionSummary,
} from "../model";
import {
  isAnthropic,
  opencodeAnthropicOAuth,
  type OpencodeGet,
  USE_CLAUDE,
  withoutOAuth,
} from "../anthropic-guard";
import { filePatch, splitPatch } from "../diff";
import { parseLine, readLines } from "../jsonl";
import { z } from "zod";
import { displayPath } from "./claude";
import {
  AnyPart,
  BashMetadata,
  Commands,
  CompactionPart,
  Config,
  EditMetadata,
  Event,
  Health,
  MessageEvent,
  Messages,
  PartDelta,
  PartEvent,
  PermissionAsked,
  Permissions,
  Providers,
  QuestionAsked,
  Questions,
  Replied,
  Session,
  SessionError,
  SessionEvent,
  SessionOnly,
  Sessions,
  StatusEvent,
  Statuses,
  StepFinish,
  TextPart,
  Todos,
  ToolPart,
} from "./opencode-schema";
import type { Harness, HarnessContext, HarnessEvent, StartOptions, UserInput } from "./types";

/**
 * opencode through `opencode serve` (docs/coder/research/opencode-report.md): one server
 * per coder session, on a random port of 127.0.0.1 behind a random password, driven
 * over HTTP with its server-sent events. Plain `fetch`, not `@opencode-ai/sdk`: coder
 * uses a dozen routes, checks every answer with Zod anyway, and the SDK would add a
 * dependency (and its generated client) for typing it does not rely on.
 *
 * Anthropic's subscription login is kept out (../anthropic-guard.ts): its tokens leave
 * the server's environment, its models are blocked in the picker, at `setModel` and
 * before every prompt. Public sharing is disabled in the server's configuration.
 */

const CAPABILITIES: Capabilities = {
  // A prompt sent during a turn waits for its end: coder queues it instead.
  steer: false,
  models: true,
  effort: true,
  modes: ["read", "ask", "edits", "full"],
  compact: true,
  resume: true,
  newSession: true,
  planMode: false,
  images: false,
};
// The server prints its address at once; a first start may migrate its database.
const SERVE_TIMEOUT_MS = 60_000;
// The first event of a stream says it is open: prompts wait for it.
const CONNECT_TIMEOUT_MS = 15_000;
const RECONNECT_DELAY_MS = 1000;
const SESSIONS_LISTED = 50;
const USERNAME = "opencode";
// Titles opencode gives before it names a session.
const PLACEHOLDER_TITLE = /^New session - /;
// A tool call refused by the user or by a deny rule: declined, not failed.
const DECLINED = /rejected permission|prevents you from using|denied/i;
// Tools shown elsewhere: questions as dialogs, todos in the plan bar.
const HIDDEN_TOOLS = new Set(["question", "todowrite"]);
const EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit", "apply_patch"]);
const ABORTED = "MessageAbortedError";

type Rule = { permission: string; pattern: string; action: "allow" | "ask" | "deny" };
const rule = (permission: string, action: Rule["action"]): Rule => ({
  permission,
  pattern: "*",
  action,
});
/**
 * Coder's modes as opencode's session rules; the last rule that matches wins
 * (opencode-report §3). Read only also runs the `plan` agent.
 */
export const MODE_RULES: Record<Mode, readonly Rule[]> = {
  read: [
    rule("*", "allow"),
    rule("edit", "deny"),
    rule("bash", "deny"),
    rule("external_directory", "ask"),
  ],
  ask: [
    rule("*", "allow"),
    rule("edit", "ask"),
    rule("bash", "ask"),
    rule("webfetch", "ask"),
    rule("external_directory", "ask"),
  ],
  edits: [
    rule("*", "allow"),
    rule("bash", "ask"),
    rule("webfetch", "ask"),
    rule("external_directory", "ask"),
  ],
  full: [rule("*", "allow"), rule("external_directory", "allow")],
};
const agentOf = (mode: Mode) => (mode === "read" ? "plan" : "build");

/** A running `opencode serve`, as the adapter uses it. */
export type OpencodeServer = {
  /** A route's JSON (`null` when empty); throws on an HTTP error. */
  call(method: string, path: string, body?: unknown): Promise<unknown>;
  /** Streams the project's events until the connection ends. */
  events(onEvent: (event: unknown) => void): Promise<void>;
  /** Resolves when the server ended, with what explains it. */
  exited: Promise<string>;
  kill(): void;
};
export type OpencodeDeps = {
  /** The user's `opencode`: found on the PATH. */
  opencode: () => string | null;
  serve(binary: string, options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<OpencodeServer>;
  /** Signs of an Anthropic subscription login (anthropic-guard.ts). */
  anthropicOAuth: (env: NodeJS.ProcessEnv, get: OpencodeGet) => Promise<readonly string[]>;
};

// The server's own lines on stderr explain an early exit.
const STDERR_KEPT = 2000;
/**
 * Starts `opencode serve` for `cwd`: a random password (HTTP Basic, user `opencode`) so
 * that no other local process drives it, and public sharing off. A configuration the
 * user passes through OPENCODE_CONFIG_CONTENT is kept, sharing turned off in it.
 */
export async function serve(
  binary: string,
  { cwd, env }: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<OpencodeServer> {
  const password = crypto.randomUUID();
  const own = z.looseObject({}).safeParse(parseLine(env.OPENCODE_CONFIG_CONTENT ?? "{}"));
  const config = JSON.stringify({ ...(own.success ? own.data : {}), share: "disabled" });
  const child = Bun.spawn([binary, "serve", "--hostname=127.0.0.1", "--port=0"], {
    cwd,
    env: {
      ...env,
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_SERVER_USERNAME: USERNAME,
      OPENCODE_CONFIG_CONTENT: config,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let stderr = "";
  void readLines(child.stderr, (line) => {
    stderr = `${stderr}${line}\n`.slice(-STDERR_KEPT);
  }).catch(() => {});
  const exited = child.exited.then(
    (code) => stderr.trim().split("\n").at(-1) || `opencode serve exited with code ${code}`,
  );
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("opencode serve did not start"));
    }, SERVE_TIMEOUT_MS);
    void readLines(child.stdout, (line) => {
      const address = /on\s+(https?:\/\/\S+)/.exec(line)?.[1];
      if (!address) return;
      clearTimeout(timer);
      resolve(address);
    }).catch(() => {});
    void exited.then((reason) => {
      clearTimeout(timer);
      reject(new Error(reason));
    });
  });
  const headers = {
    authorization: `Basic ${btoa(`${USERNAME}:${password}`)}`,
    "x-opencode-directory": encodeURIComponent(cwd),
  };
  return {
    async call(method, path, body) {
      const response = await fetch(`${url}${path}`, {
        method,
        headers: { ...headers, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      const parsed = text ? parseLine(text) : null;
      if (!response.ok) {
        const message = z
          .looseObject({
            data: z.looseObject({ message: z.string() }).optional(),
            message: z.string().optional(),
          })
          .safeParse(parsed);
        throw new Error(
          `opencode ${method} ${path}: ${message.data?.data?.message ?? message.data?.message ?? response.status}`,
        );
      }
      return parsed;
    },
    async events(onEvent) {
      try {
        const response = await fetch(`${url}/event?directory=${encodeURIComponent(cwd)}`, {
          headers,
        });
        if (!response.ok || !response.body) return;
        // One JSON object per `data:` line; comments (`: heartbeat`) and blanks skipped.
        await readLines(response.body, (line) => {
          if (line.startsWith("data:")) onEvent(parseLine(line.slice("data:".length).trim()));
        });
      } catch {
        // A broken stream ends like a closed one: the adapter reconnects.
      }
    },
    exited,
    kill: () => child.kill(),
  };
}

export const opencodeServer: OpencodeDeps = {
  opencode: () => Bun.which("opencode"),
  serve,
  anthropicOAuth: opencodeAnthropicOAuth,
};

const TODO_STATUS: Record<string, PlanStep["status"]> = {
  pending: "pending",
  in_progress: "in_progress",
  completed: "completed",
  cancelled: "completed",
};
const text = (value: unknown) => (typeof value === "string" ? value : "");

export class OpencodeHarness implements Harness {
  readonly id = "opencode" as const;
  readonly capabilities = CAPABILITIES;
  private readonly context: HarnessContext;
  private readonly deps: OpencodeDeps;
  private server: OpencodeServer | null = null;
  private options: StartOptions = { cwd: "", mode: "ask" };
  private session = "";
  /** Subagents' sessions: their requests are the user's to answer too. */
  private readonly children = new Set<string>();
  private readonly users = new Set<string>();
  private readonly shown = new Set<string>();
  private readonly pending = new Map<string, Request>();
  private providers: Providers | undefined;
  private commandNames = new Set<string>();
  private model = "";
  private variant: string | undefined;
  private blocked: readonly string[] = [];
  private running = false;
  private interrupting = false;
  private failed: string | undefined;
  private retry = 0;
  private totals = { input: 0, output: 0, cost: 0 };
  private closed = false;
  private connected: () => void = () => {};

  constructor(context: HarnessContext, deps: OpencodeDeps = opencodeServer) {
    this.context = context;
    this.deps = deps;
  }

  private emit(event: HarnessEvent) {
    this.context.emit(event);
  }

  private call(method: string, path: string, body?: unknown) {
    if (!this.server) return Promise.reject(new Error("opencode is not running"));
    return this.server.call(method, path, body);
  }
  private readonly get: OpencodeGet = (path) => this.call("GET", path).catch(() => undefined);

  async start(options: StartOptions) {
    this.options = options;
    const binary = this.deps.opencode();
    if (!binary) throw new Error("opencode is not on the PATH: install it (https://opencode.ai)");
    // Never an Anthropic subscription token in opencode's environment.
    const server = await this.deps.serve(binary, {
      cwd: options.cwd,
      env: withoutOAuth(this.context.env),
    });
    this.server = server;
    void server.exited.then((reason) => {
      if (this.server !== server || this.closed) return;
      this.server = null;
      this.emit({ type: "exited", reason });
    });
    const connected = new Promise<void>((resolve) => (this.connected = resolve));
    void this.listen(server);
    const health = Health.safeParse(await this.call("GET", "/global/health"));
    await Promise.race([connected, Bun.sleep(CONNECT_TIMEOUT_MS)]);
    this.blocked = await this.deps.anthropicOAuth(this.context.env, this.get);
    const [providers, config] = await Promise.all([this.get("/provider"), this.get("/config")]);
    const parsed = Providers.safeParse(providers);
    this.providers = parsed.success ? parsed.data : undefined;
    this.model = options.model ?? Config.safeParse(config).data?.model ?? this.defaultModel();
    this.variant = options.effort;
    const resume = options.resume === true ? (await this.listSessions())[0]?.id : options.resume;
    if (resume) await this.open(resume);
    else await this.create();
    this.emit({
      type: "info.updated",
      info: {
        ...(health.success && health.data.version ? { version: health.data.version } : {}),
        ...(this.model ? { model: this.model } : {}),
        ...(this.variant ? { effort: this.variant } : {}),
        mode: options.mode,
        ...(this.blocked.length
          ? {
              warnings: [
                `Anthropic models are blocked in opencode: ${this.blocked[0]}. ${USE_CLAUDE}`,
              ],
            }
          : {}),
      },
    });
  }

  /** The first connected provider's default model, as opencode would pick. */
  private defaultModel() {
    const provider = this.providers?.connected[0];
    const model = provider ? this.providers?.default[provider] : undefined;
    return provider && model ? `${provider}/${model}` : "";
  }

  /** Follows the project's events; reconnects and catches up when the stream breaks. */
  private async listen(server: OpencodeServer) {
    let first = true;
    while (!this.closed && this.server === server) {
      await server.events((raw) => this.event(raw));
      if (this.closed || this.server !== server) return;
      if (first)
        this.emit({
          type: "notice",
          level: "warn",
          text: "opencode connection lost: reconnecting",
        });
      first = false;
      await Bun.sleep(RECONNECT_DELAY_MS);
      void this.catchUp();
    }
  }

  /** After a reconnection: the turn's state and open requests, as the server has them. */
  private async catchUp() {
    const [statuses, permissions, questions] = await Promise.all([
      this.get("/session/status"),
      this.get("/permission"),
      this.get("/question"),
    ]);
    const status = Statuses.safeParse(statuses).data?.[this.session]?.type ?? "idle";
    if (status === "idle" && this.running) this.settle();
    else if (status !== "idle" && !this.running) this.begin();
    const open = new Set<string>();
    for (const asked of Permissions.safeParse(permissions).data ?? []) {
      open.add(asked.id);
      if (this.ours(asked.sessionID) && !this.pending.has(asked.id)) this.permission(asked);
    }
    for (const asked of Questions.safeParse(questions).data ?? []) {
      open.add(asked.id);
      if (this.ours(asked.sessionID) && !this.pending.has(asked.id)) this.question(asked);
    }
    for (const id of this.pending.keys())
      if (!open.has(id)) {
        this.pending.delete(id);
        this.emit({ type: "request.resolved", id });
      }
  }

  private ours(session: string) {
    return session === this.session || this.children.has(session);
  }

  private async create() {
    const session = Session.parse(
      await this.call("POST", "/session", { permission: MODE_RULES[this.options.mode] }),
    );
    this.reset(session.id);
  }

  /** Opens an existing session, its rules set to coder's mode again, and its transcript. */
  private async open(id: string) {
    const session = Session.parse(await this.call("GET", `/session/${id}`));
    await this.call("PATCH", `/session/${id}`, { permission: MODE_RULES[this.options.mode] });
    this.reset(session.id);
    if (session.title && !PLACEHOLDER_TITLE.test(session.title))
      this.emit({ type: "info.updated", info: { title: session.title } });
    await this.history();
  }

  private reset(session: string) {
    this.session = session;
    this.children.clear();
    this.users.clear();
    this.shown.clear();
    this.pending.clear();
    this.totals = { input: 0, output: 0, cost: 0 };
    this.emit({ type: "info.updated", info: { sessionId: session } });
  }

  private event(raw: unknown): void {
    const event = Event.safeParse(raw);
    if (!event.success) return;
    const props = event.data.properties;
    switch (event.data.type) {
      case "server.connected":
        return this.connected();
      case "session.created": {
        const created = SessionEvent.safeParse(props);
        if (created.success && created.data.info.parentID === this.session)
          this.children.add(created.data.info.id);
        return;
      }
      case "session.updated": {
        const updated = SessionEvent.safeParse(props);
        const title = updated.data?.info.title;
        if (updated.data?.info.id === this.session && title && !PLACEHOLDER_TITLE.test(title))
          this.emit({ type: "info.updated", info: { title } });
        return;
      }
      case "session.status": {
        const status = StatusEvent.safeParse(props);
        if (!status.success || status.data.sessionID !== this.session) return;
        const { type, attempt, message } = status.data.status;
        if (type === "busy" && !this.running) this.begin();
        else if (type === "idle" && this.running) this.settle();
        else if (type === "retry" && attempt !== undefined && attempt !== this.retry) {
          this.retry = attempt;
          this.emit({
            type: "notice",
            level: "warn",
            text: `Retry ${attempt}: ${message ?? "the provider failed"}`,
          });
        }
        return;
      }
      case "session.idle": {
        const idle = SessionOnly.safeParse(props);
        if (idle.success && idle.data.sessionID === this.session && this.running) this.settle();
        return;
      }
      case "session.error": {
        const error = SessionError.safeParse(props);
        if (!error.success || (error.data.sessionID && error.data.sessionID !== this.session))
          return;
        const { name, data } = error.data.error ?? { name: "UnknownError" };
        if (name === ABORTED) return;
        const message = data?.message ?? name;
        if (this.running) this.failed = message;
        else this.emit({ type: "notice", level: "error", text: message });
        return;
      }
      case "session.compacted": {
        const compacted = SessionOnly.safeParse(props);
        if (compacted.success && compacted.data.sessionID === this.session)
          this.emit({ type: "notice", level: "info", text: "Conversation compacted" });
        return;
      }
      case "message.updated": {
        const message = MessageEvent.safeParse(props);
        if (!message.success || message.data.info.sessionID !== this.session) return;
        const { id, role, providerID, modelID } = message.data.info;
        if (role === "user") this.users.add(id);
        else if (providerID && modelID && `${providerID}/${modelID}` !== this.model) {
          this.model = `${providerID}/${modelID}`;
          this.emit({ type: "info.updated", info: { model: this.model } });
        }
        return;
      }
      case "message.part.updated": {
        const part = PartEvent.safeParse(props);
        if (part.success) this.part(part.data.part);
        return;
      }
      case "message.part.delta": {
        const delta = PartDelta.safeParse(props);
        if (
          delta.success &&
          delta.data.sessionID === this.session &&
          delta.data.field === "text" &&
          this.shown.has(delta.data.partID)
        )
          this.emit({
            type: "item.delta",
            id: delta.data.partID,
            field: "text",
            delta: delta.data.delta,
          });
        return;
      }
      case "permission.asked": {
        const asked = PermissionAsked.safeParse(props);
        if (asked.success && this.ours(asked.data.sessionID)) this.permission(asked.data);
        return;
      }
      case "question.asked": {
        const asked = QuestionAsked.safeParse(props);
        if (asked.success && this.ours(asked.data.sessionID)) this.question(asked.data);
        return;
      }
      case "permission.replied":
      case "question.replied":
      case "question.rejected": {
        const replied = Replied.safeParse(props);
        if (replied.success && this.pending.delete(replied.data.requestID))
          this.emit({ type: "request.resolved", id: replied.data.requestID });
        return;
      }
      case "todo.updated": {
        const todos = Todos.safeParse(props);
        if (todos.success && todos.data.sessionID === this.session)
          this.emit({
            type: "plan.updated",
            steps: todos.data.todos.map((todo) => ({
              text: todo.content,
              status: TODO_STATUS[todo.status] ?? "pending",
            })),
          });
        return;
      }
      default:
        return;
    }
  }

  private begin() {
    this.running = true;
    this.failed = undefined;
    this.retry = 0;
    this.emit({ type: "turn.started" });
  }

  private settle() {
    this.running = false;
    for (const id of this.pending.keys()) this.emit({ type: "request.resolved", id });
    this.pending.clear();
    this.emit(
      this.interrupting
        ? { type: "turn.completed", status: "interrupted" }
        : this.failed
          ? { type: "turn.completed", status: "failed", error: this.failed }
          : { type: "turn.completed", status: "completed" },
    );
    this.interrupting = false;
  }

  /** A part as the transcript shows it; `undefined` for what it does not show. */
  private itemOf(raw: unknown): Item | undefined {
    const written = TextPart.safeParse(raw);
    if (written.success) {
      const { id, type, text: content, time, synthetic } = written.data;
      if (synthetic || this.users.has(written.data.messageID)) return undefined;
      return {
        id,
        kind: type === "text" ? "message" : "reasoning",
        text: content,
        streaming: time?.end === undefined,
        ...(time?.start ? { startedAt: time.start } : {}),
        ...(time?.end ? { endedAt: time.end } : {}),
      };
    }
    const tool = ToolPart.safeParse(raw);
    if (tool.success) return this.toolItem(tool.data);
    const compaction = CompactionPart.safeParse(raw);
    if (compaction.success) return { id: compaction.data.id, kind: "compaction", status: "done" };
    return undefined;
  }

  private toolItem(part: z.infer<typeof ToolPart>): Item | undefined {
    const { id, tool, state } = part;
    if (HIDDEN_TOOLS.has(tool) || (state.status === "pending" && !Object.keys(state.input).length))
      return undefined;
    const status: ItemStatus =
      state.status === "completed"
        ? "done"
        : state.status === "error"
          ? DECLINED.test(state.error ?? "")
            ? "declined"
            : "error"
          : "running";
    const { input } = state;
    const output = state.output ?? state.error ?? "";
    if (tool === "bash") {
      const metadata = BashMetadata.safeParse(state.metadata ?? {});
      const exit = metadata.data?.exit;
      return {
        id,
        kind: "command",
        command: text(input.command),
        output: state.output ?? metadata.data?.output ?? state.error ?? "",
        ...(typeof exit === "number" ? { exitCode: exit } : {}),
        status,
      };
    }
    if (EDIT_TOOLS.has(tool))
      return { id, kind: "file_change", files: this.filesOf(state), status };
    if (tool === "task")
      return {
        id,
        kind: "subagent",
        title: text(input.description) || "subagent",
        detail: text(input.prompt),
        tools: 0,
        status,
      };
    return {
      id,
      kind: "tool",
      name: tool,
      title:
        state.title ||
        [input.filePath, input.path, input.pattern, input.url, input.query]
          .map(text)
          .find(Boolean) ||
        "",
      input: JSON.stringify(input),
      output,
      status,
    };
  }

  /** A file change's patches: opencode's own diff, else the written content. */
  private filesOf(state: z.infer<typeof ToolPart>["state"]): FilePatch[] {
    const metadata = EditMetadata.safeParse(state.metadata ?? {});
    const diff = metadata.data?.filediff?.patch ?? metadata.data?.diff;
    if (diff)
      return splitPatch(diff).map((file) => ({
        ...file,
        path: displayPath(this.options.cwd, file.path),
      }));
    const path = text(state.input.filePath);
    const content = state.input.content;
    return path && typeof content === "string"
      ? [filePatch(displayPath(this.options.cwd, path), "", content)]
      : [];
  }

  private part(raw: unknown) {
    const base = AnyPart.safeParse(raw);
    if (!base.success || base.data.sessionID !== this.session) return;
    const finish = StepFinish.safeParse(raw);
    if (finish.success) return this.usage(finish.data);
    const item = this.itemOf(raw);
    if (!item) return;
    const done =
      item.kind === "message" || item.kind === "reasoning"
        ? !item.streaming
        : "status" in item && item.status !== "running";
    this.shown.add(item.id);
    this.emit(done ? { type: "item.completed", item } : { type: "item.started", item });
  }

  private usage(step: z.infer<typeof StepFinish>) {
    const tokens = step.tokens;
    if (!tokens) return;
    this.totals = {
      input: this.totals.input + tokens.input,
      output: this.totals.output + tokens.output,
      cost: this.totals.cost + (step.cost ?? 0),
    };
    const window = this.limitOf(this.model);
    const used =
      tokens.input + tokens.output + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0);
    this.emit({
      type: "usage.updated",
      usage: {
        tokens: { input: this.totals.input, output: this.totals.output },
        costUsd: this.totals.cost,
        ...(window ? { context: { used, window } } : {}),
      },
    });
  }

  private limitOf(model: string) {
    const [provider, id] = this.split(model);
    return this.providers?.all.find((p) => p.id === provider)?.models[id]?.limit?.context;
  }

  private split(model: string): [string, string] {
    const at = model.indexOf("/");
    return at < 0 ? ["", model] : [model.slice(0, at), model.slice(at + 1)];
  }

  private permission(asked: z.infer<typeof PermissionAsked>) {
    const { id, permission, patterns, metadata } = asked;
    const edit = EditMetadata.safeParse(metadata);
    const diff = edit.data?.diff;
    const files = diff
      ? splitPatch(diff).map((file) => ({
          ...file,
          path: displayPath(this.options.cwd, file.path),
        }))
      : [];
    const request: Request = {
      id,
      openedAt: Date.now(),
      kind: "approval",
      title:
        permission === "bash"
          ? "Run a command"
          : permission === "edit"
            ? "Change a file"
            : `Use ${permission}`,
      ...(permission === "bash" ? { command: text(metadata.command) || patterns.join("\n") } : {}),
      ...(files.length ? { files } : {}),
      ...(permission !== "bash" && !files.length ? { detail: patterns.join("\n") } : {}),
      decisions: ["once", "session", "deny"],
    };
    this.pending.set(id, request);
    this.emit({ type: "request.opened", request });
  }

  private question(asked: z.infer<typeof QuestionAsked>) {
    const request: Request = {
      id: asked.id,
      openedAt: Date.now(),
      kind: "question",
      questions: asked.questions.map((q) => ({
        question: q.question,
        ...(q.header ? { header: q.header } : {}),
        options: q.options.map((o) => ({
          label: o.label,
          ...(o.description ? { description: o.description } : {}),
        })),
        ...(q.multiple ? { multiple: true } : {}),
      })),
    };
    this.pending.set(asked.id, request);
    this.emit({ type: "request.opened", request });
  }

  async respond(request: Request, response: Response) {
    if (!this.pending.has(request.id)) throw new Error("opencode no longer waits for this answer");
    this.pending.delete(request.id);
    if (request.kind === "question") {
      await (response.kind === "question"
        ? this.call("POST", `/question/${request.id}/reply`, { answers: response.answers })
        : this.call("POST", `/question/${request.id}/reject`));
      return;
    }
    // "always" lasts for the session in opencode: coder's "session".
    const reply =
      response.kind === "approval" && response.decision === "once"
        ? "once"
        : response.kind === "approval" &&
            (response.decision === "session" || response.decision === "always")
          ? "always"
          : "reject";
    await this.call("POST", `/permission/${request.id}/reply`, { reply });
  }

  /** Refuses Anthropic's models while a subscription login is around, asked again each time. */
  private async guard(model: string) {
    this.blocked = await this.deps.anthropicOAuth(this.context.env, this.get);
    if (this.blocked.length && isAnthropic(this.split(model)[0]))
      throw new Error(`This model is Anthropic's: ${USE_CLAUDE}`);
  }

  private modelBody() {
    const [providerID, modelID] = this.split(this.model);
    return providerID ? { providerID, modelID } : undefined;
  }

  async send({ text: message }: UserInput) {
    await this.guard(this.model);
    const model = this.modelBody();
    const agent = agentOf(this.options.mode);
    const command = /^\/(\S+)\s*([\s\S]*)$/.exec(message);
    if (command?.[1] && this.commandNames.has(command[1])) {
      // Answered at the end of the command's turn: progress comes as events.
      void this.call("POST", `/session/${this.session}/command`, {
        command: command[1],
        arguments: command[2] ?? "",
        agent,
        ...(this.model ? { model: this.model } : {}),
        ...(this.variant ? { variant: this.variant } : {}),
      }).catch((error: unknown) => this.failure(error));
      return;
    }
    await this.call("POST", `/session/${this.session}/prompt_async`, {
      ...(model ? { model } : {}),
      agent,
      ...(this.variant ? { variant: this.variant } : {}),
      parts: [{ type: "text", text: message }],
    });
  }

  private failure(error: unknown) {
    this.emit({
      type: "notice",
      level: "error",
      text: error instanceof Error ? error.message : String(error),
    });
  }

  async steer(input: UserInput) {
    await this.send(input);
  }

  async interrupt() {
    if (!this.running) return;
    this.interrupting = true;
    await this.call("POST", `/session/${this.session}/abort`);
  }

  async setModel(model: string, effort?: string) {
    if (!model.includes("/")) throw new Error(`opencode names models provider/model, not ${model}`);
    await this.guard(model);
    this.model = model;
    this.variant = effort;
    this.emit({ type: "info.updated", info: { model, ...(effort ? { effort } : {}) } });
  }

  async setMode(mode: Mode) {
    await this.call("PATCH", `/session/${this.session}`, { permission: MODE_RULES[mode] });
    this.options = { ...this.options, mode };
  }

  async compact() {
    const model = this.modelBody();
    if (!model) throw new Error("No model to compact with: pick one first");
    // Answered once the summary is written: progress comes as events.
    void this.call("POST", `/session/${this.session}/summarize`, model).catch((error: unknown) =>
      this.failure(error),
    );
  }

  async newSession() {
    await this.create();
  }

  async resume(id: string) {
    await this.open(id);
  }

  /** The transcript of the open session, as opencode stored it. */
  private async history() {
    const messages = Messages.safeParse(await this.call("GET", `/session/${this.session}/message`));
    if (!messages.success) return;
    const items: Item[] = [];
    for (const { info, parts } of messages.data) {
      if (info.role === "user") {
        const said = parts
          .flatMap((p) => {
            const part = TextPart.safeParse(p);
            return part.success && part.data.type === "text" && !part.data.synthetic
              ? [part.data.text]
              : [];
          })
          .join("");
        if (said) items.push({ id: info.id, kind: "user", text: said });
        continue;
      }
      for (const part of parts) {
        const item = this.itemOf(part);
        if (item && !(item.kind === "message" && !item.text.trim()))
          items.push(
            item.kind === "message" || item.kind === "reasoning"
              ? { ...item, streaming: false }
              : item,
          );
      }
    }
    this.emit({ type: "history", items });
  }

  async listSessions(): Promise<readonly SessionSummary[]> {
    const sessions = Sessions.safeParse(
      await this.call(
        "GET",
        `/session?directory=${encodeURIComponent(this.options.cwd)}&roots=true&limit=${SESSIONS_LISTED}`,
      ),
    );
    if (!sessions.success) return [];
    return sessions.data
      .filter((s) => !s.parentID)
      .map((s) => ({
        id: s.id,
        title: s.title ?? s.id,
        updatedAt: s.time?.updated ?? s.time?.created ?? 0,
        ...(s.directory ? { cwd: s.directory } : {}),
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, SESSIONS_LISTED);
  }

  async models(): Promise<readonly ModelInfo[]> {
    const providers = this.providers;
    if (!providers) return [];
    this.blocked = await this.deps.anthropicOAuth(this.context.env, this.get);
    return providers.all
      .filter((p) => providers.connected.includes(p.id))
      .flatMap((p) =>
        Object.values(p.models).map((m) => ({
          id: `${p.id}/${m.id}`,
          label: `${m.name ?? m.id} (${p.name ?? p.id})`,
          efforts: Object.keys(m.variants ?? {}),
          ...(this.blocked.length && isAnthropic(p.id) ? { blocked: USE_CLAUDE } : {}),
        })),
      );
  }

  async commands(): Promise<readonly CommandInfo[]> {
    const commands = Commands.safeParse(await this.call("GET", "/command"));
    if (!commands.success) return [];
    this.commandNames = new Set(commands.data.map((c) => c.name));
    return commands.data.map((c) => ({
      name: c.name,
      description: c.description ?? "",
      source: "harness" as const,
    }));
  }

  async close() {
    this.closed = true;
    this.server?.kill();
    this.server = null;
  }
}
