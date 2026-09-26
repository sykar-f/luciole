import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
  Capabilities,
  CommandInfo,
  FilePatch,
  Item,
  Mode,
  ModelInfo,
  Request,
  Response,
  SessionSummary,
} from "../../components/model";
import { isAnthropic, piAnthropicOAuth, USE_CLAUDE, withoutOAuth } from "../anthropic-guard";
import { filePatch, stats } from "../diff";
import { LineProcess, parseLine } from "../jsonl";
import { ALLOW_ONCE, ALLOW_SESSION, DENY, GATE_TITLE, gateFile, MODE_COMMAND } from "../pi-gate";
import { displayPath } from "./claude";
import { z } from "zod";
import {
  AssistantDelta,
  Commands,
  EditDetails,
  Event,
  ExtensionError,
  GateRequest,
  MessageEvent,
  Messages,
  Models,
  Queue,
  Response as PiResponse,
  Retry,
  SessionHeader,
  SessionName,
  State,
  Stats,
  ThinkingLevel,
  partsOf,
  Role,
  ToolEnd,
  ToolStart,
  ToolUpdate,
  UiRequest,
} from "./pi-schema";
import type { Harness, HarnessContext, HarnessEvent, StartOptions, UserInput } from "./types";

/**
 * pi through `pi --mode rpc` (docs/coder/research/pi-report.md): JSON lines on stdio,
 * one process per session. pi asks nothing before running a tool: coder's gate
 * (../pi-gate.ts) does, through pi's extension dialogs. Anthropic's subscription login
 * is kept out (../anthropic-guard.ts): its tokens leave pi's environment, its models are
 * blocked in the picker, at `set_model` and before every prompt.
 */

const CAPABILITIES: Capabilities = {
  steer: true,
  models: true,
  effort: true,
  modes: ["read", "ask", "edits", "full"],
  compact: true,
  resume: true,
  newSession: true,
  planMode: false,
  images: false,
};
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const READ_TOOLS = "read,grep,find,ls";
// A command pi does not answer is reported: pi answers at once, even `abort` settles soon.
const COMMAND_TIMEOUT_MS = 30_000;
// Session files read for the resume picker: the head holds the header and the first prompt.
const KIB = 1024;
const SESSION_HEAD_KIB = 64;
const SESSION_HEAD_BYTES = SESSION_HEAD_KIB * KIB;
// The first prompt names a session in the resume picker.
const TITLE_LENGTH = 80;
const Edits = z.array(z.object({ oldText: z.string(), newText: z.string() }));
const SESSIONS_LISTED = 50;

type Command = Record<string, unknown> & { type: string };
type PiProcess = {
  write(value: unknown): boolean;
  kill(): void;
  exited: Promise<string>;
};
export type PiDeps = {
  spawn(
    argv: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; onLine: (line: string) => void },
  ): PiProcess;
  /** The user's `pi`: found on the PATH. */
  pi: () => string | null;
  /** Signs of an Anthropic subscription login (anthropic-guard.ts). */
  anthropicOAuth: (env: NodeJS.ProcessEnv, pi: string) => Promise<readonly string[]>;
  /** pi's sessions directory for a project. */
  sessions: (cwd: string, env: NodeJS.ProcessEnv) => string;
};
/** `~/.pi/agent/sessions/--<cwd, / as ->--` (pi-report §5), or pi's own override. */
export const sessionDirectory = (cwd: string, env: NodeJS.ProcessEnv) =>
  join(
    env.PI_CODING_AGENT_SESSION_DIR ??
      join(env.PI_CODING_AGENT_DIR ?? join(env.HOME ?? homedir(), ".pi", "agent"), "sessions"),
    `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`,
  );
export const piProcess: PiDeps = {
  spawn: (argv, options) => new LineProcess(argv, options),
  pi: () => Bun.which("pi"),
  anthropicOAuth: piAnthropicOAuth,
  sessions: sessionDirectory,
};

const textOf = (parts: readonly unknown[]) =>
  parts
    .flatMap((p) =>
      typeof p === "object" && p !== null && "text" in p && typeof p.text === "string"
        ? [p.text]
        : [],
    )
    .join("");

export class PiHarness implements Harness {
  readonly id = "pi" as const;
  readonly capabilities = CAPABILITIES;
  private readonly context: HarnessContext;
  private readonly deps: PiDeps;
  private process: PiProcess | null = null;
  private options: StartOptions = { cwd: "", mode: "ask" };
  private readonly waiting = new Map<
    string,
    (response: { success: boolean; error?: string; data?: unknown }) => void
  >();
  private readonly pending = new Map<string, { ui: string; request: Request }>();
  private readonly tools = new Map<string, Item>();
  /** Tool events, handled one after the other. */
  private toolEvents: Promise<void> = Promise.resolve();
  private blocked: readonly string[] = [];
  private provider = "";
  private message = 0;
  private running = false;
  private interrupting = false;
  private failed: string | undefined;
  private closed = false;
  private next = 0;

  constructor(context: HarnessContext, deps: PiDeps = piProcess) {
    this.context = context;
    this.deps = deps;
  }

  private emit(event: HarnessEvent) {
    this.context.emit(event);
  }

  async start(options: StartOptions) {
    this.options = options;
    const pi = this.deps.pi();
    if (!pi) throw new Error("pi is not on the PATH: install pi (https://pi.dev)");
    this.blocked = await this.deps.anthropicOAuth(this.context.env, pi);
    const resume = options.resume === true ? (await this.listSessions())[0]?.id : options.resume;
    const sessionId = resume ?? crypto.randomUUID();
    const process = this.deps.spawn(
      [
        pi,
        "--mode",
        "rpc",
        "--session-id",
        sessionId,
        // Project resources (.pi/extensions…) run code: not without the user's own pi
        // having trusted them.
        "--no-approve",
        "-e",
        gateFile(),
        "--coder-mode",
        options.mode,
        ...(options.mode === "read" ? ["--tools", READ_TOOLS] : []),
        ...(options.model ? ["--model", options.model] : []),
        ...(options.effort ? ["--thinking", options.effort] : []),
      ],
      // Never an Anthropic subscription token in pi's environment.
      { cwd: options.cwd, env: withoutOAuth(this.context.env), onLine: (line) => this.line(line) },
    );
    this.process = process;
    void process.exited.then((reason) => {
      if (this.process !== process || this.closed) return;
      this.process = null;
      for (const [, resolve] of this.waiting) resolve({ success: false, error: reason });
      this.waiting.clear();
      this.emit({ type: "exited", reason });
    });
    await this.refresh();
    if (this.blocked.length)
      this.emit({
        type: "info.updated",
        info: {
          warnings: [`Anthropic models are blocked in pi: ${this.blocked[0]}. ${USE_CLAUDE}`],
        },
      });
    if (resume) await this.history();
  }

  /** Sends a command and resolves with pi's response (success: false on failure). */
  private command(command: Command) {
    const id = `c${++this.next}`;
    return new Promise<{ success: boolean; error?: string; data?: unknown }>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve({ success: false, error: `pi did not answer ${command.type}` });
      }, COMMAND_TIMEOUT_MS);
      this.waiting.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      if (!this.process?.write({ ...command, id })) {
        clearTimeout(timer);
        this.waiting.delete(id);
        resolve({ success: false, error: "pi is not running" });
      }
    });
  }
  private async must(command: Command) {
    const response = await this.command(command);
    if (!response.success) throw new Error(response.error ?? `pi refused ${command.type}`);
    return response.data;
  }

  /** Model, session and effort, as pi reports them. */
  private async refresh() {
    const state = State.safeParse(await this.must({ type: "get_state" }));
    if (!state.success) return;
    this.provider = state.data.model?.provider ?? "";
    this.emit({
      type: "info.updated",
      info: {
        ...(state.data.sessionId ? { sessionId: state.data.sessionId } : {}),
        ...(state.data.model
          ? { model: `${state.data.model.provider}/${state.data.model.id}` }
          : {}),
        ...(state.data.thinkingLevel ? { effort: state.data.thinkingLevel } : {}),
        ...(state.data.sessionName ? { title: state.data.sessionName } : {}),
        mode: this.options.mode,
      },
    });
  }

  private line(text: string) {
    const raw = parseLine(text);
    const response = PiResponse.safeParse(raw);
    if (response.success && response.data.id && this.waiting.has(response.data.id)) {
      const { success, error, data } = response.data;
      this.waiting.get(response.data.id)?.({ success, error, data });
      this.waiting.delete(response.data.id);
      return;
    }
    const event = Event.safeParse(raw);
    if (event.success) this.event(event.data.type, raw);
  }

  private event(type: string, raw: unknown): void {
    switch (type) {
      case "agent_start":
        this.running = true;
        this.failed = undefined;
        this.emit({ type: "turn.started" });
        return;
      case "message_start": {
        const event = MessageEvent.safeParse(raw);
        if (event.success && event.data.message.role === "assistant") this.message++;
        return;
      }
      case "message_update":
        return this.delta(raw);
      case "message_end":
        return this.messageEnd(raw);
      // In order: a start reads the file for its diff, its end must not overtake it.
      case "tool_execution_start":
        return this.tool(() => this.toolStart(raw));
      case "tool_execution_update":
        return this.tool(() => this.toolUpdate(raw));
      case "tool_execution_end":
        return this.tool(() => this.toolEnd(raw));
      case "queue_update": {
        const queue = Queue.safeParse(raw);
        if (queue.success)
          this.emit({
            type: "queue.updated",
            queued: [...queue.data.steering, ...queue.data.followUp],
          });
        return;
      }
      case "compaction_start":
        this.emit({
          type: "item.started",
          item: {
            id: `compaction-${this.message}`,
            kind: "compaction",
            status: "running",
            startedAt: Date.now(),
          },
        });
        return;
      case "compaction_end":
        this.emit({
          type: "item.completed",
          item: {
            id: `compaction-${this.message}`,
            kind: "compaction",
            status: "done",
            endedAt: Date.now(),
          },
        });
        return;
      case "auto_retry_start": {
        const retry = Retry.safeParse(raw);
        if (retry.success)
          this.emit({
            type: "notice",
            level: "warn",
            text: `Retry ${retry.data.attempt ?? "?"}/${retry.data.maxAttempts ?? "?"}: ${retry.data.errorMessage ?? ""}`,
          });
        return;
      }
      case "auto_retry_end": {
        const retry = Retry.safeParse(raw);
        if (retry.success && retry.data.success === false)
          this.failed = retry.data.finalError ?? "Retries exhausted";
        return;
      }
      case "extension_ui_request":
        void this.dialog(raw);
        return;
      case "extension_error": {
        const error = ExtensionError.safeParse(raw);
        if (error.success)
          this.emit({ type: "notice", level: "error", text: `pi extension: ${error.data.error}` });
        return;
      }
      case "session_info_changed": {
        const name = SessionName.safeParse(raw);
        if (name.success && name.data.name)
          this.emit({ type: "info.updated", info: { title: name.data.name } });
        return;
      }
      case "thinking_level_changed": {
        const level = ThinkingLevel.safeParse(raw);
        if (level.success) this.emit({ type: "info.updated", info: { effort: level.data.level } });
        return;
      }
      case "agent_settled":
        // After the turn's last tool event: its items complete before the turn does.
        return this.tool(() => void this.settled());
      default:
        return;
    }
  }

  private tool(handle: () => void | Promise<void>) {
    this.toolEvents = this.toolEvents.then(handle).catch(() => {});
  }

  private async settled() {
    if (!this.running) return;
    this.running = false;
    for (const [id] of this.pending) this.emit({ type: "request.resolved", id });
    this.pending.clear();
    this.emit(
      this.interrupting
        ? { type: "turn.completed", status: "interrupted" }
        : this.failed
          ? { type: "turn.completed", status: "failed", error: this.failed }
          : { type: "turn.completed", status: "completed" },
    );
    this.interrupting = false;
    const stats = Stats.safeParse((await this.command({ type: "get_session_stats" })).data);
    if (!stats.success) return;
    const { tokens, cost, contextUsage } = stats.data;
    this.emit({
      type: "usage.updated",
      usage: {
        ...(tokens ? { tokens: { input: tokens.input, output: tokens.output } } : {}),
        ...(cost !== undefined ? { costUsd: cost } : {}),
        ...(contextUsage?.tokens && contextUsage.contextWindow
          ? { context: { used: contextUsage.tokens, window: contextUsage.contextWindow } }
          : {}),
      },
    });
  }

  private delta(raw: unknown) {
    const update = AssistantDelta.safeParse(raw);
    if (!update.success) return;
    const { type, contentIndex = 0, delta } = update.data.assistantMessageEvent;
    const kind = type.startsWith("text_")
      ? "message"
      : type.startsWith("thinking_")
        ? "reasoning"
        : undefined;
    if (!kind) return;
    const id = `pi-${this.message}-${contentIndex}`;
    if (type.endsWith("_start"))
      this.emit({
        type: "item.started",
        item: { id, kind, text: "", streaming: true, startedAt: Date.now() },
      });
    else if (type.endsWith("_delta") && delta)
      this.emit({ type: "item.delta", id, field: "text", delta });
  }

  private messageEnd(raw: unknown) {
    const event = z.looseObject({ message: Role }).safeParse(raw);
    if (!event.success || event.data.message.role !== "assistant") return;
    // Authoritative: each text and thinking part as pi finished it.
    partsOf(event.data.message.content).forEach((part, index) => {
      const id = `pi-${this.message}-${index}`;
      if (part.kind === "tool" || !part.text.trim()) return;
      this.emit({
        type: "item.completed",
        item: {
          id,
          kind: part.kind === "text" ? "message" : "reasoning",
          text: part.text,
          streaming: false,
          endedAt: Date.now(),
        },
      });
    });
    const ended = z
      .looseObject({ stopReason: z.string().optional(), errorMessage: z.string().optional() })
      .safeParse(event.data.message);
    if (ended.success && ended.data.stopReason === "error")
      this.failed = ended.data.errorMessage ?? "pi stopped with an error";
  }

  private async patchOf(tool: string, args: Record<string, unknown>): Promise<FilePatch[]> {
    const path = typeof args.path === "string" ? args.path : undefined;
    if (!path) return [];
    const shown = displayPath(this.options.cwd, path);
    const before = await readFile(resolve(this.options.cwd, path), "utf8").catch(() => "");
    if (tool === "write" && typeof args.content === "string")
      return [filePatch(shown, before, args.content)];
    const edits = Edits.safeParse(args.edits);
    if (tool === "edit" && edits.success) {
      const after = edits.data.reduce(
        (text, edit) => text.replace(edit.oldText, edit.newText),
        before,
      );
      return [filePatch(shown, before, after)];
    }
    return [];
  }

  private async toolStart(raw: unknown) {
    const start = ToolStart.safeParse(raw);
    if (!start.success) return;
    const { toolCallId: id, toolName: tool, args } = start.data;
    const base = { id, startedAt: Date.now() };
    const item: Item =
      tool === "bash" && typeof args.command === "string"
        ? { ...base, kind: "command", command: args.command, output: "", status: "running" }
        : tool === "edit" || tool === "write"
          ? {
              ...base,
              kind: "file_change",
              files: await this.patchOf(tool, args),
              status: "running",
            }
          : {
              ...base,
              kind: "tool",
              name: tool,
              title:
                typeof args.path === "string"
                  ? args.path
                  : typeof args.pattern === "string"
                    ? args.pattern
                    : "",
              input: JSON.stringify(args),
              output: "",
              status: "running",
            };
    this.tools.set(id, item);
    this.emit({ type: "item.started", item });
  }

  private toolUpdate(raw: unknown) {
    const update = ToolUpdate.safeParse(raw);
    if (!update.success) return;
    const item = this.tools.get(update.data.toolCallId);
    if (!item || (item.kind !== "command" && item.kind !== "tool")) return;
    // pi sends the output so far, not what is new: the item is replaced.
    const next = { ...item, output: textOf(update.data.partialResult?.content ?? []) };
    this.tools.set(item.id, next);
    this.emit({ type: "item.started", item: next });
  }

  private toolEnd(raw: unknown) {
    const end = ToolEnd.safeParse(raw);
    if (!end.success) return;
    const item = this.tools.get(end.data.toolCallId);
    if (!item) return;
    this.tools.delete(item.id);
    const output = textOf(end.data.result.content);
    const declined =
      end.data.isError === true && /declined|read-only mode|No one can approve/.test(output);
    const status = declined ? "declined" : end.data.isError ? "error" : "done";
    const endedAt = Date.now();
    if (item.kind === "file_change") {
      // pi's edit reports its patch: the one the transcript keeps.
      const details = EditDetails.safeParse(end.data.result.details);
      const files =
        details.success && item.files[0]
          ? [{ ...item.files[0], patch: details.data.patch, ...stats(details.data.patch) }]
          : item.files;
      this.emit({ type: "item.completed", item: { ...item, files, status, endedAt } });
    } else if (item.kind === "command" || item.kind === "tool")
      this.emit({ type: "item.completed", item: { ...item, output, status, endedAt } });
  }

  /** pi's dialogs: the gate's approvals, and other extensions' questions. */
  private async dialog(raw: unknown) {
    const request = UiRequest.safeParse(raw);
    if (!request.success) return;
    const { id: ui, method, title, message, options } = request.data;
    if (method === "notify") {
      this.emit({
        type: "notice",
        level:
          request.data.notifyType === "error"
            ? "error"
            : request.data.notifyType === "warning"
              ? "warn"
              : "info",
        text: message ?? title ?? "",
      });
      return;
    }
    if (method !== "select" && method !== "confirm") {
      // Fire-and-forget methods need nothing; text input is not coder's to give.
      if (method === "input" || method === "editor") {
        this.process?.write({ type: "extension_ui_response", id: ui, cancelled: true });
        this.emit({
          type: "notice",
          level: "warn",
          text: `A pi extension asked for text (${title ?? method}): coder cannot answer it yet`,
        });
      }
      return;
    }
    const id = `pi-${ui}`;
    const openedAt = Date.now();
    const gate = title?.startsWith(GATE_TITLE)
      ? GateRequest.safeParse(parseLine(title.slice(GATE_TITLE.length)))
      : undefined;
    let shown: Request;
    if (gate?.success) {
      const { tool, input } = gate.data;
      const files = tool === "edit" || tool === "write" ? await this.patchOf(tool, input) : [];
      shown = {
        id,
        openedAt,
        kind: "approval",
        title:
          tool === "bash"
            ? "Run a command"
            : tool === "edit" || tool === "write"
              ? "Change a file"
              : `Use ${tool}`,
        ...(tool === "bash" && typeof input.command === "string" ? { command: input.command } : {}),
        ...(files.length ? { files } : {}),
        ...(tool !== "bash" && !files.length ? { detail: JSON.stringify(input) } : {}),
        decisions: ["once", "session", "deny"],
      };
    } else
      shown = {
        id,
        openedAt,
        kind: "question",
        questions: [
          {
            question: [title, message].filter(Boolean).join("\n") || "A pi extension asks",
            options: (method === "confirm" ? ["Yes", "No"] : (options ?? [])).map((label) => ({
              label,
            })),
          },
        ],
      };
    this.pending.set(id, { ui, request: shown });
    this.emit({ type: "request.opened", request: shown });
  }

  async respond(request: Request, response: Response) {
    const pending = this.pending.get(request.id);
    if (!pending) throw new Error("pi no longer waits for this answer");
    this.pending.delete(request.id);
    const { ui } = pending;
    let answer: Record<string, unknown>;
    if (response.kind === "cancel") answer = { cancelled: true };
    else if (request.kind === "approval")
      answer = {
        value:
          response.kind === "approval" && response.decision === "once"
            ? ALLOW_ONCE
            : response.kind === "approval" && response.decision === "session"
              ? ALLOW_SESSION
              : DENY,
      };
    else {
      const label = response.kind === "question" ? response.answers[0]?.[0] : undefined;
      const confirm =
        request.kind === "question" &&
        request.questions[0]?.options.length === 2 &&
        request.questions[0].options[0]?.label === "Yes";
      answer =
        label === undefined
          ? { cancelled: true }
          : confirm
            ? { confirmed: label === "Yes" }
            : { value: label };
    }
    if (!this.process?.write({ type: "extension_ui_response", id: ui, ...answer }))
      throw new Error("pi is not running");
  }

  private guard() {
    if (this.blocked.length && isAnthropic(this.provider))
      throw new Error(`This model is Anthropic's: ${USE_CLAUDE}`);
  }

  async send({ text }: UserInput) {
    this.guard();
    await this.must({ type: "prompt", message: text });
  }

  async steer({ text }: UserInput) {
    this.guard();
    await this.must({ type: "steer", message: text });
  }

  async interrupt() {
    if (!this.running) return;
    this.interrupting = true;
    // Queued steering would start a turn right after the abort.
    await this.command({ type: "clear_queue" });
    void this.command({ type: "abort" });
  }

  async setModel(model: string, effort?: string) {
    const at = model.indexOf("/");
    if (at < 0) throw new Error(`pi names models provider/model, not ${model}`);
    const provider = model.slice(0, at);
    if (this.blocked.length && isAnthropic(provider)) throw new Error(USE_CLAUDE);
    await this.must({ type: "set_model", provider, modelId: model.slice(at + 1) });
    this.provider = provider;
    if (effort !== undefined) await this.must({ type: "set_thinking_level", level: effort });
  }

  async setMode(mode: Mode) {
    // The gate's own command: it runs at once, without asking the model.
    await this.must({
      type: "prompt",
      message: `/${MODE_COMMAND} ${mode}`,
      ...(this.running ? { streamingBehavior: "steer" } : {}),
    });
    this.options = { ...this.options, mode };
  }

  async compact() {
    // Answered once the summary is written: progress comes as compaction events.
    void this.command({ type: "compact" }).then((response) => {
      if (!response.success)
        this.emit({
          type: "notice",
          level: "error",
          text: `Compaction failed: ${response.error ?? "pi refused"}`,
        });
    });
  }

  async newSession() {
    const data = await this.must({ type: "new_session" });
    if (typeof data === "object" && data !== null && "cancelled" in data && data.cancelled === true)
      throw new Error("A pi extension refused a new session");
    await this.refresh();
  }

  async resume(id: string) {
    const file = (await this.sessionFiles()).find((f) => f.id === id);
    if (!file) throw new Error(`No pi session ${id} in this project`);
    await this.must({ type: "switch_session", sessionPath: file.path });
    await this.refresh();
    await this.history();
  }

  /** The transcript of the session pi has open. */
  private async history() {
    const messages = Messages.safeParse(await this.must({ type: "get_messages" }));
    if (!messages.success) return;
    const items: Item[] = [];
    const tools = new Map<string, number>();
    const Result = z.looseObject({
      role: z.literal("toolResult"),
      toolCallId: z.string(),
      content: z.unknown(),
      isError: z.boolean().optional(),
    });
    messages.data.messages.forEach((raw, turn) => {
      const result = Result.safeParse(raw);
      if (result.success) {
        const at = tools.get(result.data.toolCallId);
        const item = at === undefined ? undefined : items[at];
        if (at !== undefined && item && (item.kind === "command" || item.kind === "tool"))
          items[at] = {
            ...item,
            output: partsOf(result.data.content)
              .flatMap((p) => (p.kind === "text" ? [p.text] : []))
              .join(""),
            status: result.data.isError ? "error" : "done",
          };
        return;
      }
      const message = Role.safeParse(raw);
      if (!message.success) return;
      const parts = partsOf(message.data.content);
      if (message.data.role === "user") {
        const text = parts.flatMap((p) => (p.kind === "text" ? [p.text] : [])).join("");
        if (text) items.push({ id: `pi-history-${turn}`, kind: "user", text });
        return;
      }
      if (message.data.role !== "assistant") return;
      parts.forEach((part, i) => {
        const id = `pi-history-${turn}-${i}`;
        if (part.kind === "tool") {
          const command = typeof part.args.command === "string" ? part.args.command : undefined;
          tools.set(part.id, items.length);
          items.push(
            part.name === "bash" && command
              ? { id: part.id, kind: "command", command, output: "", status: "done" }
              : {
                  id: part.id,
                  kind: "tool",
                  name: part.name,
                  title: typeof part.args.path === "string" ? part.args.path : "",
                  input: JSON.stringify(part.args),
                  output: "",
                  status: "done",
                },
          );
        } else if (part.text.trim())
          items.push({
            id,
            kind: part.kind === "text" ? "message" : "reasoning",
            text: part.text,
            streaming: false,
          });
      });
    });
    this.emit({ type: "history", items });
  }

  private async sessionFiles() {
    const directory = this.deps.sessions(this.options.cwd, this.context.env);
    const entries = await readdir(directory).catch(() => []);
    const files = await Promise.all(
      entries
        .filter((name) => name.endsWith(".jsonl"))
        .map(async (name) => {
          const path = join(directory, name);
          const [head, info] = await Promise.all([
            Bun.file(path).slice(0, SESSION_HEAD_BYTES).text(),
            stat(path),
          ]);
          const lines = head.split("\n");
          const header = SessionHeader.safeParse(parseLine(lines[0] ?? ""));
          if (!header.success) return [];
          // Entries of type "message" hold an AgentMessage (session-format.md).
          const firstPrompt = lines.slice(1).flatMap((line) => {
            const entry = z.looseObject({ message: Role }).safeParse(parseLine(line));
            return entry.success && entry.data.message.role === "user"
              ? partsOf(entry.data.message.content).flatMap((p) =>
                  p.kind === "text" ? [p.text] : [],
                )
              : [];
          })[0];
          return [
            {
              id: header.data.id,
              path,
              title: firstPrompt?.slice(0, TITLE_LENGTH) || header.data.id,
              updatedAt: info.mtimeMs,
            },
          ];
        }),
    );
    return files.flat().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async listSessions(): Promise<readonly SessionSummary[]> {
    return (await this.sessionFiles())
      .slice(0, SESSIONS_LISTED)
      .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
  }

  async models(): Promise<readonly ModelInfo[]> {
    const models = Models.safeParse(await this.must({ type: "get_available_models" }));
    if (!models.success) return [];
    return models.data.models.map((m) => ({
      id: `${m.provider}/${m.id}`,
      label: `${m.name ?? m.id} (${m.provider})`,
      efforts: m.reasoning ? THINKING_LEVELS : [],
      ...(this.blocked.length && isAnthropic(m.provider) ? { blocked: USE_CLAUDE } : {}),
    }));
  }

  async commands(): Promise<readonly CommandInfo[]> {
    const commands = Commands.safeParse(await this.must({ type: "get_commands" }));
    return commands.success
      ? commands.data.commands
          .filter((c) => c.name !== MODE_COMMAND)
          .map((c) => ({
            name: c.name,
            description: c.description ?? "",
            source: "harness" as const,
          }))
      : [];
  }

  async close() {
    this.closed = true;
    this.process?.kill();
    this.process = null;
  }
}
