import { readFile } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import {
  getSessionMessages,
  listSessions,
  query,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  Capabilities,
  CommandInfo,
  Decision,
  FilePatch,
  Item,
  Mode,
  ModelInfo,
  Question,
  Request,
  Response,
  SessionSummary,
} from "../model";
import { filePatch } from "../diff";
import {
  AgentInput,
  BashInput,
  BlockDelta,
  BlockStart,
  BlockStop,
  MessageStart,
  BashResult,
  EditInput,
  EditResult,
  InitializeResult,
  MultiEditInput,
  PlanInput,
  QuestionInput,
  SessionInfo,
  SessionMessage,
  TodoInput,
  WriteInput,
  isToolResult,
  isToolUse,
  parseMessage,
  type ClaudeMessage,
  type ContentBlock,
  type ToolResult,
  type ToolUse,
} from "./claude-protocol";
import type { Harness, HarnessContext, HarnessEvent, StartOptions, UserInput } from "./types";

/**
 * Claude Code through the Agent SDK (docs/coder/research/claude-code-report.md): one
 * long `query()` in streaming-input mode per session, fed by an inbox of user messages.
 * It always runs the user's own `claude` (pathToClaudeCodeExecutable), signed in by them;
 * never the binary the SDK bundles, never `--bare`, the environment passed whole.
 */

/**
 * Full access is not Claude's `bypassPermissions`: that mode never consults
 * `canUseTool`, so questions and plan reviews could not reach the user (and the SDK
 * warns on every query). Claude stays in `default` and coder allows each tool itself.
 */
const MODE_TO_CLAUDE: Record<Mode, PermissionMode> = {
  read: "plan",
  ask: "default",
  edits: "acceptEdits",
  full: "default",
};
const CLAUDE_TO_MODE: Partial<Record<string, Mode>> = {
  plan: "read",
  default: "ask",
  acceptEdits: "edits",
  bypassPermissions: "full",
};
const CAPABILITIES: Capabilities = {
  steer: true,
  models: true,
  effort: true,
  modes: ["read", "ask", "edits", "full"],
  compact: true,
  resume: true,
  newSession: true,
  planMode: true,
  images: false,
};
const PERCENT = 100;
const SECOND_MS = 1000;
const SESSIONS_LISTED = 50;
// Restarts of the query in a row without a message in between.
const MAX_RESTARTS = 1;
const INPUT_SHOWN = 2000;
// Tools whose call is a dialog (a question, a plan): the dialog says it, not a tool row.
const DIALOG_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/** The parts of the SDK's Query coder uses: tests replay recorded streams through it. */
export type QueryLike = AsyncIterable<unknown> & {
  interrupt(): Promise<unknown>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  applyFlagSettings(settings: {
    effortLevel?: "low" | "medium" | "high" | "xhigh" | "max" | null;
  }): Promise<void>;
  initializationResult(): Promise<unknown>;
  close(): void;
};
export type QueryOptions = NonNullable<Parameters<typeof query>[0]["options"]>;
export type ClaudeDeps = {
  query: (params: { prompt: AsyncIterable<SDKUserMessage>; options: QueryOptions }) => QueryLike;
  listSessions: (options: { dir: string; limit: number }) => Promise<readonly unknown[]>;
  getSessionMessages: (id: string, options: { dir: string }) => Promise<readonly unknown[]>;
  /** The user's `claude`: found on the PATH. */
  claude: () => string | null;
};
export const sdk: ClaudeDeps = {
  query,
  listSessions,
  getSessionMessages,
  claude: () => Bun.which("claude"),
};

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];
const isEffort = (value: string | undefined): value is Effort => EFFORTS.some((e) => e === value);

/** User messages for the running query, handed over as it asks for them. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private readonly queued: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  push(text: string) {
    this.queued.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      origin: { kind: "human" },
    });
    this.wake?.();
  }
  close() {
    this.closed = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      const next = this.queued.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = null;
    }
  }
}

const textOfResult = (result: ToolResult) =>
  typeof result.content === "string"
    ? result.content
    : (result.content ?? []).map((part) => part.text ?? "").join("\n");
const clipped = (text: string) =>
  text.length > INPUT_SHOWN ? `${text.slice(0, INPUT_SHOWN)}…` : text;
/** One line that says what a tool call does: its path, pattern, URL or query. */
function titleOf(input: Record<string, unknown>) {
  for (const key of [
    "file_path",
    "path",
    "pattern",
    "url",
    "query",
    "command",
    "description",
    "skill",
  ]) {
    const value = input[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

// macOS: temporary directories are reached through /private; compare without it.
const unprivate = (path: string) => path.replace(/^\/private(?=\/)/, "");
/** A file path as the transcript shows it: relative to the project when inside it. */
export const displayPath = (cwd: string, path: string) => {
  const inside = relative(unprivate(cwd), unprivate(path));
  return inside && !inside.startsWith("..") && !isAbsolute(inside) ? inside : path;
};

/** File patches of an edit, from what the tool says it changed. */
async function patchesOf(cwd: string, tool: ToolUse, structured?: unknown): Promise<FilePatch[]> {
  const shown = (path: string) => displayPath(cwd, path);
  const reported = EditResult.safeParse(structured);
  // Before the change: what the tool reports it replaced (null: it created the file),
  // else the file as it is now (asked before the tool ran).
  const before = async (path: string) =>
    reported.success && reported.data.originalFile !== undefined
      ? (reported.data.originalFile ?? "")
      : readFile(path, "utf8").catch(() => "");
  const replace = (
    text: string,
    e: { old_string: string; new_string: string; replace_all?: boolean },
  ) =>
    e.replace_all
      ? text.split(e.old_string).join(e.new_string)
      : text.replace(e.old_string, e.new_string);
  const edit = EditInput.safeParse(tool.input);
  if (edit.success) {
    const original = await before(edit.data.file_path);
    return original.includes(edit.data.old_string)
      ? [filePatch(shown(edit.data.file_path), original, replace(original, edit.data))]
      : [filePatch(shown(edit.data.file_path), edit.data.old_string, edit.data.new_string)];
  }
  const multi = MultiEditInput.safeParse(tool.input);
  if (multi.success) {
    const original = await before(multi.data.file_path);
    return [
      filePatch(shown(multi.data.file_path), original, multi.data.edits.reduce(replace, original)),
    ];
  }
  const write = WriteInput.safeParse(tool.input);
  if (write.success)
    return [
      filePatch(
        shown(write.data.file_path),
        await before(write.data.file_path),
        write.data.content,
      ),
    ];
  return [];
}

/**
 * Turns SDK messages into neutral events. Separate from the process so that a resumed
 * session's stored messages go through the same translation.
 */
export class Translator {
  private readonly tools = new Map<string, { tool: ToolUse; item: Item }>();
  private readonly tasks = new Map<string, string>();
  // Text and thinking streamed as partial messages: the whole message then adds nothing.
  private readonly streamed = new Set<string>();
  private readonly blocks = new Map<
    number,
    { id: string; kind: "message" | "reasoning"; text: string }
  >();
  private messageId = "";
  private readonly emit: (event: HarnessEvent) => void;
  private readonly cwd: string;
  constructor(emit: (event: HarnessEvent) => void, cwd: string) {
    this.emit = emit;
    this.cwd = cwd;
  }

  async translate(message: ClaudeMessage) {
    switch (message.type) {
      case "stream_event":
        if (message.parent_tool_use_id) return;
        return this.stream(message.event);
      case "assistant":
        if (message.parent_tool_use_id) return this.nested(message.parent_tool_use_id);
        if (message.error)
          this.emit({ type: "notice", level: "error", text: assistantError(message.error) });
        for (const [index, block] of message.message.content.entries())
          await this.assistantBlock(message.message.id, index, block);
        return;
      case "user":
        if (typeof message.message.content === "string") return;
        for (const block of message.message.content)
          if (isToolResult(block)) await this.toolResult(block, message.tool_use_result);
        return;
      case "system":
        return this.system(message);
      default:
        return;
    }
  }

  private stream(event: unknown) {
    const start = MessageStart.safeParse(event);
    if (start.success) {
      this.messageId = start.data.message.id;
      this.blocks.clear();
      return;
    }
    const open = BlockStart.safeParse(event);
    if (open.success) {
      const type = open.data.content_block.type;
      const kind = type === "text" ? "message" : type === "thinking" ? "reasoning" : undefined;
      if (!kind) return;
      const id = `${this.messageId}:${open.data.index}`;
      this.blocks.set(open.data.index, { id, kind, text: "" });
      this.streamed.add(this.messageId);
      this.emit({
        type: "item.started",
        item: { id, kind, text: "", streaming: true, startedAt: Date.now() },
      });
      return;
    }
    const delta = BlockDelta.safeParse(event);
    if (delta.success) {
      const block = this.blocks.get(delta.data.index);
      const text = delta.data.delta.text ?? delta.data.delta.thinking;
      if (!block || text === undefined) return;
      block.text += text;
      this.emit({ type: "item.delta", id: block.id, field: "text", delta: text });
      return;
    }
    const stop = BlockStop.safeParse(event);
    if (stop.success) {
      const block = this.blocks.get(stop.data.index);
      if (!block) return;
      this.blocks.delete(stop.data.index);
      this.emit({
        type: "item.completed",
        item: {
          id: block.id,
          kind: block.kind,
          text: block.text,
          streaming: false,
          endedAt: Date.now(),
        },
      });
    }
  }

  private async assistantBlock(messageId: string, index: number, block: ContentBlock) {
    if ((block.type === "text" || block.type === "thinking") && !this.streamed.has(messageId)) {
      const text =
        "text" in block && typeof block.text === "string"
          ? block.text
          : "thinking" in block && typeof block.thinking === "string"
            ? block.thinking
            : "";
      if (!text.trim()) return;
      this.emit({
        type: "item.completed",
        item: {
          id: `${messageId}:${index}`,
          kind: block.type === "text" ? "message" : "reasoning",
          text,
          streaming: false,
        },
      });
      return;
    }
    if (isToolUse(block)) await this.toolUse(block);
  }

  private async toolUse(tool: ToolUse) {
    if (DIALOG_TOOLS.has(tool.name)) return;
    if (tool.name === "TodoWrite") {
      const todos = TodoInput.safeParse(tool.input);
      if (todos.success)
        this.emit({
          type: "plan.updated",
          steps: todos.data.todos.map((t) => ({ text: t.content, status: t.status })),
        });
      return;
    }
    const base = { id: tool.id, startedAt: Date.now() };
    let item: Item;
    const bash = BashInput.safeParse(tool.input);
    if (tool.name === "Bash" && bash.success)
      item = {
        ...base,
        kind: "command",
        command: bash.data.command,
        output: "",
        status: "running",
      };
    else if (EDIT_TOOLS.has(tool.name))
      item = {
        ...base,
        kind: "file_change",
        files: await patchesOf(this.cwd, tool),
        status: "running",
      };
    else if (tool.name === "Task" || tool.name === "Agent") {
      const agent = AgentInput.safeParse(tool.input);
      item = {
        ...base,
        kind: "subagent",
        title:
          (agent.success && (agent.data.description ?? agent.data.subagent_type)) || "subagent",
        detail: agent.success ? (agent.data.prompt ?? "") : "",
        tools: 0,
        status: "running",
      };
    } else
      item = {
        ...base,
        kind: "tool",
        name: tool.name,
        title: titleOf(tool.input),
        input: clipped(JSON.stringify(tool.input)),
        output: "",
        status: "running",
      };
    this.tools.set(tool.id, { tool, item });
    this.emit({ type: "item.started", item });
  }

  private async toolResult(result: ToolResult, structured: unknown) {
    const known = this.tools.get(result.tool_use_id);
    if (!known) return;
    this.tools.delete(result.tool_use_id);
    const { tool, item } = known;
    const failed = result.is_error === true;
    const endedAt = Date.now();
    const text = textOfResult(result);
    switch (item.kind) {
      case "command": {
        const out = BashResult.safeParse(structured);
        const output = out.success
          ? [out.data.stdout, out.data.stderr].filter(Boolean).join("\n")
          : text;
        this.emit({
          type: "item.completed",
          item: { ...item, output, status: failed ? "error" : "done", endedAt },
        });
        return;
      }
      case "file_change": {
        // An empty patch (a rewrite with the same text) keeps the one shown when it started.
        const files = (await patchesOf(this.cwd, tool, structured)).filter((f) => f.patch);
        this.emit({
          type: "item.completed",
          item: {
            ...item,
            files: files.length ? files : item.files,
            status: failed ? (/rejected|doesn't want/i.test(text) ? "declined" : "error") : "done",
            endedAt,
          },
        });
        return;
      }
      case "subagent":
        this.emit({
          type: "item.completed",
          item: { ...item, status: failed ? "error" : "done", endedAt },
        });
        return;
      case "tool":
        this.emit({
          type: "item.completed",
          item: { ...item, output: text, status: failed ? "error" : "done", endedAt },
        });
        return;
      default:
        return;
    }
  }

  /** Activity inside a subagent: counted on its row. */
  private nested(parent: string) {
    const known = this.tools.get(parent);
    if (known?.item.kind !== "subagent") return;
    known.item = { ...known.item, tools: known.item.tools + 1 };
    this.emit({ type: "item.started", item: known.item });
  }

  private system(message: ClaudeMessage & { type: "system" }) {
    switch (message.subtype) {
      case "status":
        if ("status" in message && message.status === "compacting")
          this.emit({
            type: "item.started",
            item: {
              id: "compaction",
              kind: "compaction",
              status: "running",
              startedAt: Date.now(),
            },
          });
        if ("permissionMode" in message && message.permissionMode) {
          const mode = CLAUDE_TO_MODE[message.permissionMode];
          if (mode) this.emit({ type: "info.updated", info: { mode } });
        }
        return;
      case "compact_boundary":
        this.emit({
          type: "item.completed",
          item: { id: `compaction-${Date.now()}`, kind: "compaction", status: "done" },
        });
        return;
      case "task_started":
        if ("tool_use_id" in message && message.tool_use_id)
          this.tasks.set(message.task_id, message.tool_use_id);
        return;
      case "task_progress": {
        const tool = this.tasks.get(message.task_id);
        const known = tool ? this.tools.get(tool) : undefined;
        const used = "usage" in message ? message.usage?.tool_uses : undefined;
        if (known?.item.kind === "subagent" && used !== undefined) {
          known.item = { ...known.item, tools: used };
          this.emit({ type: "item.started", item: known.item });
        }
        return;
      }
      case "informational":
        if ("content" in message)
          this.emit({
            type: "notice",
            level: message.level === "warning" ? "warn" : "info",
            text: message.content,
          });
        return;
      case "api_retry":
        if ("attempt" in message)
          this.emit({
            type: "notice",
            level: "warn",
            text: `The API failed: retry ${message.attempt}/${message.max_retries}`,
          });
        return;
      default:
        return;
    }
  }

  /** Items still running when the turn ended: settled by the session. */
  forget() {
    this.tools.clear();
    this.blocks.clear();
  }
}

const assistantError = (error: string) =>
  error === "authentication_failed" || error === "oauth_org_not_allowed"
    ? "Claude Code is not signed in: run `claude auth login` in a terminal"
    : error === "billing_error" || error === "account_on_hold"
      ? `Claude Code: ${error.replace(/_/g, " ")} (see your Claude account)`
      : `Claude Code: ${error.replace(/_/g, " ")}`;

/** The user's answer to a permission, in the SDK's terms. */
function permission(
  request: Request,
  response: Response,
  input: Record<string, unknown>,
  suggestions: readonly PermissionUpdate[],
): PermissionResult {
  if (response.kind === "cancel")
    return { behavior: "deny", message: "The user stopped the turn.", interrupt: true };
  if (request.kind === "question") {
    if (response.kind !== "question") return { behavior: "deny", message: "No answer." };
    const answers: Record<string, string> = {};
    request.questions.forEach(
      (q, i) => (answers[q.question] = (response.answers[i] ?? []).join(", ")),
    );
    return { behavior: "allow", updatedInput: { ...input, answers } };
  }
  if (request.kind === "plan_review") {
    if (response.kind === "plan_review" && response.approve)
      return { behavior: "allow", updatedInput: input };
    const feedback = response.kind === "plan_review" ? response.feedback : undefined;
    return {
      behavior: "deny",
      message: feedback
        ? `Keep planning: ${feedback}`
        : "Keep planning: the user did not approve this plan.",
    };
  }
  if (response.kind !== "approval" || response.decision === "deny")
    return { behavior: "deny", message: "The user declined this action." };
  if (response.decision === "session")
    return { behavior: "allow", updatedInput: input, updatedPermissions: [...suggestions] };
  if (response.decision === "always")
    return {
      behavior: "allow",
      updatedInput: input,
      updatedPermissions: suggestions.map((s) =>
        s.type === "addRules" ? { ...s, destination: "localSettings" } : s,
      ),
    };
  return { behavior: "allow", updatedInput: input };
}

export class ClaudeHarness implements Harness {
  readonly id = "claude" as const;
  readonly capabilities = CAPABILITIES;
  private readonly context: HarnessContext;
  private readonly deps: ClaudeDeps;
  private options: StartOptions = { cwd: "", mode: "ask" };
  private sessionId = "";
  /** Whether Claude Code wrote the session: a resume of one it never wrote fails. */
  private written = false;
  private query: QueryLike | null = null;
  private inbox: Inbox | null = null;
  private translator: Translator;
  private initialized: Promise<unknown> | null = null;
  private running = false;
  private interrupting = false;
  private closed = false;
  private generation = 0;
  private restarts = 0;
  private readonly pending = new Map<string, (response: Response) => void>();
  private next = 0;

  constructor(context: HarnessContext, deps: ClaudeDeps = sdk) {
    this.context = context;
    this.deps = deps;
    this.translator = new Translator(this.relay, "");
  }

  private readonly relay = (event: HarnessEvent) => this.emit(event);
  private emit(event: HarnessEvent) {
    // Claude reports `default` in full access (MODE_TO_CLAUDE): the mode stays coder's.
    if (event.type === "info.updated" && event.info.mode === "ask" && this.options.mode === "full")
      this.context.emit({ ...event, info: { ...event.info, mode: "full" } });
    else this.context.emit(event);
  }

  async start(options: StartOptions) {
    this.options = options;
    const wanted =
      options.resume === true
        ? await this.latestSession()
        : typeof options.resume === "string"
          ? options.resume
          : undefined;
    // A session remembered for this launch may never have been written (no prompt yet).
    const resume = wanted && (await this.exists(wanted)) ? wanted : undefined;
    if (wanted && !resume)
      this.emit({
        type: "notice",
        level: "info",
        text: `No Claude Code session ${wanted} in this directory: a new one starts`,
      });
    await this.open(resume);
    if (resume) await this.history(resume);
  }

  private async exists(id: string) {
    const messages = await this.deps
      .getSessionMessages(id, { dir: this.options.cwd })
      .catch(() => []);
    return messages.length > 0;
  }

  /** A new query on the current session: resumed once Claude Code wrote it. */
  private reopen() {
    return this.written ? this.open(this.sessionId) : this.open(undefined, this.sessionId);
  }

  private async latestSession() {
    const [latest] = (await this.deps.listSessions({ dir: this.options.cwd, limit: 1 })).flatMap(
      (s) => {
        const parsed = SessionInfo.safeParse(s);
        return parsed.success ? [parsed.data] : [];
      },
    );
    return latest?.sessionId;
  }

  /** Starts a query: a new session (a chosen id, or `id`), or a resumed one. */
  private async open(resume?: string, id?: string) {
    const claude = this.deps.claude();
    if (!claude)
      throw new Error("claude is not on the PATH: install Claude Code (https://code.claude.com)");
    this.stopQuery();
    const generation = ++this.generation;
    this.sessionId = resume ?? id ?? crypto.randomUUID();
    this.written = resume !== undefined;
    const inbox = new Inbox();
    this.inbox = inbox;
    this.translator = new Translator(this.relay, this.options.cwd);
    const effort = isEffort(this.options.effort) ? this.options.effort : undefined;
    const q = this.deps.query({
      prompt: inbox,
      options: {
        cwd: this.options.cwd,
        // The user's own binary, signed in by them: never the one the SDK bundles.
        pathToClaudeCodeExecutable: claude,
        // `env` replaces the child's environment: HOME, PATH and the keychain need it whole.
        env: {
          ...this.context.env,
          CLAUDE_CODE_ENABLE_TODO_TOOLS: "1",
          CLAUDE_AGENT_SDK_CLIENT_APP: this.options.client ?? "airtty-coder",
        },
        // Without the preset, the SDK runs a minimal prompt, not Claude Code's.
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          ...(this.options.instructions ? { append: this.options.instructions } : {}),
        },
        settingSources: this.options.isolated ? [] : ["user", "project", "local"],
        // Isolated, the user's MCP servers stay out too: none from any configuration, and
        // none of the claude.ai connectors their account would bring (SDK 0.3.283 types).
        ...(this.options.isolated
          ? { strictMcpConfig: true, mcpServers: {}, settings: { disableClaudeAiConnectors: true } }
          : {}),
        ...(this.options.tools ? { tools: [...this.options.tools] } : {}),
        permissionMode: MODE_TO_CLAUDE[this.options.mode],
        includePartialMessages: true,
        // Opus 4.7 and later omit thinking text unless asked for a summary.
        thinking: { type: "adaptive", display: "summarized" },
        ...(this.options.model ? { model: this.options.model } : {}),
        ...(effort ? { effort } : {}),
        ...(resume ? { resume } : { sessionId: this.sessionId }),
        canUseTool: (tool, input, options) => this.ask(tool, input, options),
      },
    });
    this.query = q;
    void this.consume(q, generation);
    this.initialized = q.initializationResult();
    const init = InitializeResult.safeParse(await this.initialized);
    this.emit({
      type: "info.updated",
      info: {
        sessionId: this.sessionId,
        mode: this.options.mode,
        ...(init.success && init.data.account?.email
          ? {
              account: [init.data.account.email, init.data.account.subscriptionType]
                .filter(Boolean)
                .join(" · "),
            }
          : {}),
      },
    });
  }

  private async consume(q: QueryLike, generation: number) {
    let failure: string | undefined;
    try {
      for await (const raw of q) {
        if (generation !== this.generation) return;
        this.restarts = 0;
        const message = parseMessage(raw);
        if (message) await this.handle(message);
      }
    } catch (error: unknown) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (generation !== this.generation || this.closed) return;
    // A query that ends again before saying anything will not get better by restarting.
    if (++this.restarts > MAX_RESTARTS) {
      this.running = false;
      this.cancelPending();
      this.emit({ type: "exited", reason: failure ?? "Claude Code stopped" });
      return;
    }
    // The SDK ends its stream after an error result (an interrupt among them): the session
    // goes on in a new query on the same session id.
    const wasRunning = this.running;
    this.running = false;
    this.cancelPending();
    if (wasRunning)
      this.emit({
        type: "turn.completed",
        status: this.interrupting ? "interrupted" : "failed",
        ...(this.interrupting ? {} : { error: failure ?? "Claude Code stopped" }),
      });
    this.interrupting = false;
    try {
      await this.reopen();
    } catch (error: unknown) {
      this.emit({ type: "exited", reason: error instanceof Error ? error.message : String(error) });
    }
  }

  private async handle(message: ClaudeMessage) {
    if (message.type === "system" && message.subtype === "init" && "session_id" in message) {
      this.sessionId = message.session_id;
      const mode = message.permissionMode ? CLAUDE_TO_MODE[message.permissionMode] : undefined;
      const warnings =
        message.apiKeySource && message.apiKeySource !== "none"
          ? [
              `An API key (${message.apiKeySource}) is used instead of your Claude subscription in this session`,
            ]
          : [];
      this.emit({
        type: "info.updated",
        info: {
          sessionId: message.session_id,
          ...(message.model ? { model: message.model } : {}),
          ...(mode ? { mode } : {}),
          ...(message.claude_code_version ? { version: message.claude_code_version } : {}),
          ...(warnings.length ? { warnings } : {}),
        },
      });
      return;
    }
    if (message.type === "rate_limit_event") {
      const windows = message.rate_limit_info.unifiedWindows;
      const percent = (u?: number) => (u === undefined ? undefined : u * PERCENT);
      this.emit({
        type: "usage.updated",
        usage: {
          limits: {
            fiveHour: percent(windows?.five_hour?.utilization),
            weekly: percent(windows?.seven_day?.utilization),
            resetsAt: message.rate_limit_info.resetsAt
              ? message.rate_limit_info.resetsAt * SECOND_MS
              : undefined,
          },
        },
      });
      return;
    }
    if (message.type === "result") {
      const used = message.usage
        ? (message.usage.input_tokens ?? 0) +
          (message.usage.cache_read_input_tokens ?? 0) +
          (message.usage.cache_creation_input_tokens ?? 0)
        : undefined;
      const window = Object.values(message.modelUsage ?? {})[0]?.contextWindow;
      this.emit({
        type: "usage.updated",
        usage: {
          ...(message.total_cost_usd !== undefined ? { costUsd: message.total_cost_usd } : {}),
          ...(used !== undefined && window ? { context: { used, window } } : {}),
          ...(message.usage
            ? {
                tokens: {
                  input: message.usage.input_tokens ?? 0,
                  output: message.usage.output_tokens ?? 0,
                },
              }
            : {}),
        },
      });
      this.running = false;
      this.translator.forget();
      const failed = message.subtype !== "success" || message.is_error === true;
      this.emit(
        this.interrupting || message.terminal_reason?.startsWith("aborted")
          ? { type: "turn.completed", status: "interrupted" }
          : failed
            ? {
                type: "turn.completed",
                status: "failed",
                error:
                  message.errors?.join("\n") || message.result || `Claude Code: ${message.subtype}`,
              }
            : { type: "turn.completed", status: "completed" },
      );
      this.interrupting = false;
      return;
    }
    if (message.type === "conversation_reset") {
      this.emit({ type: "history", items: [] });
      return;
    }
    await this.translator.translate(message);
  }

  /** `canUseTool`: every permission, question and plan, as a request the user answers. */
  private async ask(
    tool: string,
    input: Record<string, unknown>,
    options: {
      signal: AbortSignal;
      suggestions?: PermissionUpdate[];
      title?: string;
      description?: string;
      decisionReason?: string;
      toolUseID: string;
      suppressAlwaysAllowRule?: boolean;
    },
  ): Promise<PermissionResult> {
    if (this.options.mode === "full" && !DIALOG_TOOLS.has(tool))
      return { behavior: "allow", updatedInput: input };
    const id = `claude-${options.toolUseID}-${++this.next}`;
    const openedAt = Date.now();
    let request: Request;
    const question = QuestionInput.safeParse(input);
    const plan = PlanInput.safeParse(input);
    if (tool === "AskUserQuestion" && question.success)
      request = {
        id,
        openedAt,
        kind: "question",
        questions: question.data.questions.map((q): Question => ({
          question: q.question,
          header: q.header,
          multiple: q.multiSelect,
          options: q.options.map((o) => ({ label: o.label, description: o.description })),
        })),
      };
    else if (tool === "ExitPlanMode" && plan.success)
      request = { id, openedAt, kind: "plan_review", plan: plan.data.plan ?? "(no plan text)" };
    else {
      const suggestions = options.suggestions ?? [];
      const rules = suggestions.some((s) => s.type === "addRules");
      const decisions: Decision[] = [
        "once",
        ...(suggestions.length ? (["session"] as const) : []),
        ...(rules && !options.suppressAlwaysAllowRule ? (["always"] as const) : []),
        "deny",
      ];
      const bash = BashInput.safeParse(input);
      const files = EDIT_TOOLS.has(tool)
        ? await patchesOf(this.options.cwd, {
            type: "tool_use",
            id: options.toolUseID,
            name: tool,
            input,
          })
        : [];
      request = {
        id,
        openedAt,
        kind: "approval",
        title: options.title ?? `${tool}${options.description ? ` · ${options.description}` : ""}`,
        ...(tool === "Bash" && bash.success ? { command: bash.data.command } : {}),
        ...(files.length ? { files } : {}),
        detail:
          [
            options.decisionReason,
            tool === "Bash" && bash.success ? bash.data.description : undefined,
          ]
            .filter(Boolean)
            .join("\n") ||
          (tool === "Bash" || files.length ? undefined : titleOf(input) || undefined),
        decisions,
      };
    }
    const response = await new Promise<Response>((resolve) => {
      const cancel = () => {
        this.pending.delete(id);
        this.emit({ type: "request.resolved", id });
        resolve({ kind: "cancel" });
      };
      if (options.signal.aborted) return cancel();
      options.signal.addEventListener("abort", cancel, { once: true });
      this.pending.set(id, (answer) => {
        options.signal.removeEventListener("abort", cancel);
        resolve(answer);
      });
      this.emit({ type: "request.opened", request });
    });
    const result = permission(request, response, input, options.suggestions ?? []);
    // An approved plan leaves plan mode: back to asking for each change.
    if (request.kind === "plan_review" && result.behavior === "allow") {
      this.options = { ...this.options, mode: "ask" };
      void this.query?.setPermissionMode("default").catch(() => {});
      this.emit({ type: "info.updated", info: { mode: "ask" } });
    }
    return result;
  }

  private cancelPending() {
    for (const [id, resolve] of this.pending) {
      this.pending.delete(id);
      this.emit({ type: "request.resolved", id });
      resolve({ kind: "cancel" });
    }
  }

  private async ready() {
    await this.initialized;
    if (!this.inbox) throw new Error("Claude Code is not running");
    return this.inbox;
  }

  async send({ text }: UserInput) {
    const inbox = await this.ready();
    this.written = true;
    this.running = true;
    this.emit({ type: "turn.started" });
    inbox.push(text);
  }

  async steer({ text }: UserInput) {
    // Pushed while a turn runs: Claude Code takes it into the running turn.
    (await this.ready()).push(text);
  }

  async interrupt() {
    if (!this.running) return;
    this.interrupting = true;
    this.cancelPending();
    await this.query?.interrupt();
  }

  async respond(request: Request, response: Response) {
    const resolve = this.pending.get(request.id);
    if (!resolve) throw new Error("Claude Code no longer waits for this answer");
    this.pending.delete(request.id);
    resolve(response);
  }

  async setModel(model: string, effort?: string) {
    await this.initialized;
    await this.query?.setModel(model);
    this.options = { ...this.options, model };
    if (effort !== undefined) {
      if (!isEffort(effort)) throw new Error(`Unknown effort ${effort}`);
      await this.query?.applyFlagSettings({ effortLevel: effort });
      this.options = { ...this.options, effort };
    }
  }

  async setMode(mode: Mode) {
    await this.initialized;
    this.options = { ...this.options, mode };
    await this.query?.setPermissionMode(MODE_TO_CLAUDE[mode]);
  }

  async compact() {
    await this.send({ text: "/compact" });
  }

  async newSession() {
    await this.open();
  }

  async resume(id: string) {
    await this.open(id);
    await this.history(id);
  }

  /** A resumed session's transcript, through the same translation as a live one. */
  private async history(id: string) {
    const messages = await this.deps
      .getSessionMessages(id, { dir: this.options.cwd })
      .catch(() => []);
    const items = new Map<string, Item>();
    const translator = new Translator((event) => {
      if (event.type === "item.started" || event.type === "item.completed")
        items.set(event.item.id, event.item);
    }, this.options.cwd);
    const collected: Item[] = [];
    let turn = 0;
    for (const raw of messages) {
      const stored = SessionMessage.safeParse(raw);
      if (!stored.success) continue;
      if (stored.data.type === "user") {
        const content = parseMessage({
          type: "user",
          message: stored.data.message,
          parent_tool_use_id: stored.data.parent_tool_use_id ?? null,
        });
        if (content?.type === "user" && typeof content.message.content === "string") {
          collected.push(...items.values());
          items.clear();
          collected.push({
            id: `history-user-${++turn}`,
            kind: "user",
            text: content.message.content,
          });
          continue;
        }
        const texts =
          content?.type === "user" && Array.isArray(content.message.content)
            ? content.message.content.flatMap((b) =>
                b.type === "text" && "text" in b && typeof b.text === "string" ? [b.text] : [],
              )
            : [];
        if (texts.length && !texts.some((t) => t.startsWith("["))) {
          collected.push(...items.values());
          items.clear();
          collected.push({ id: `history-user-${++turn}`, kind: "user", text: texts.join("\n") });
        }
        if (content) await translator.translate(content);
        continue;
      }
      const assistant = parseMessage({
        type: "assistant",
        message: stored.data.message,
        parent_tool_use_id: stored.data.parent_tool_use_id ?? null,
      });
      if (assistant) await translator.translate(assistant);
    }
    collected.push(...items.values());
    // Whatever did not finish in the stored session is shown as finished.
    const settled = collected.map((item): Item =>
      "status" in item && item.status === "running" ? { ...item, status: "done" } : item,
    );
    this.emit({ type: "history", items: settled });
  }

  async listSessions(): Promise<readonly SessionSummary[]> {
    const sessions = await this.deps.listSessions({
      dir: this.options.cwd,
      limit: SESSIONS_LISTED,
    });
    return sessions.flatMap((s) => {
      const parsed = SessionInfo.safeParse(s);
      if (!parsed.success) return [];
      const { sessionId, customTitle, summary, firstPrompt, lastModified } = parsed.data;
      return [
        {
          id: sessionId,
          title: customTitle || summary || firstPrompt || sessionId,
          updatedAt: lastModified,
        },
      ];
    });
  }

  async models(): Promise<readonly ModelInfo[]> {
    const init = InitializeResult.safeParse(await this.initialized);
    if (!init.success) return [];
    return init.data.models.map((m) => ({
      id: m.value,
      label: m.displayName ?? m.value,
      efforts: m.supportedEffortLevels ?? [],
    }));
  }

  async commands(): Promise<readonly CommandInfo[]> {
    const init = InitializeResult.safeParse(await this.initialized);
    if (!init.success) return [];
    return init.data.commands.map((c) => ({
      name: c.name,
      description: c.description ?? "",
      source: "harness",
    }));
  }

  private stopQuery() {
    this.generation++;
    this.inbox?.close();
    this.inbox = null;
    this.query?.close();
    this.query = null;
    this.running = false;
  }

  async close() {
    this.closed = true;
    this.cancelPending();
    this.stopQuery();
  }
}
