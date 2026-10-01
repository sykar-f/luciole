import type {
  Capabilities,
  CommandInfo,
  Decision,
  FilePatch,
  Item,
  ItemStatus,
  Mode,
  ModelInfo,
  Request,
  Response,
  SessionSummary,
} from "../model";
import { stats } from "../diff";
import { RpcPeer, type RpcHandlers } from "../jsonl";
import { displayPath } from "./claude";
import type { InitializeParams } from "./codex-protocol/InitializeParams";
import { CODEX_PROTOCOL_VERSION as PROTOCOL_VERSION } from "./codex-protocol/version";
import type { CommandExecutionRequestApprovalResponse } from "./codex-protocol/v2/CommandExecutionRequestApprovalResponse";
import type { FileChangeRequestApprovalResponse } from "./codex-protocol/v2/FileChangeRequestApprovalResponse";
import type { ModelListParams } from "./codex-protocol/v2/ModelListParams";
import type { SkillsListParams } from "./codex-protocol/v2/SkillsListParams";
import type { ThreadCompactStartParams } from "./codex-protocol/v2/ThreadCompactStartParams";
import type { ThreadListParams } from "./codex-protocol/v2/ThreadListParams";
import type { ThreadResumeParams } from "./codex-protocol/v2/ThreadResumeParams";
import type { ThreadStartParams } from "./codex-protocol/v2/ThreadStartParams";
import type { ToolRequestUserInputResponse } from "./codex-protocol/v2/ToolRequestUserInputResponse";
import type { TurnInterruptParams } from "./codex-protocol/v2/TurnInterruptParams";
import type { TurnStartParams } from "./codex-protocol/v2/TurnStartParams";
import type { TurnSteerParams } from "./codex-protocol/v2/TurnSteerParams";
import type { UserInput as CodexInput } from "./codex-protocol/v2/UserInput";
import {
  AccountResponse,
  CommandApproval,
  Delta,
  ErrorNotification,
  FileApproval,
  InitializeResponse,
  ItemNotification,
  Message,
  ModelList,
  PlanUpdated,
  RateLimits,
  Resolved,
  SkillsList,
  ThreadItem,
  ThreadList,
  ThreadResponse,
  TokenUsage,
  TurnNotification,
  TurnStartResponse,
  UserInputRequest,
} from "./codex-schema";
import type { Harness, HarnessContext, HarnessEvent, StartOptions, UserInput } from "./types";

/**
 * Codex through `codex app-server`: JSON-RPC on
 * stdio, one thread per session. Approvals and questions are Codex's own requests; coder
 * answers each one once. The protocol is experimental: the types coder sends were
 * generated from codex 0.156.1 (./codex-protocol) and a different version is reported.
 */

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
const SESSIONS_LISTED = 50;
const MODELS_LISTED = 100;
const SECOND_MS = 1000;
const FIVE_HOURS_MINUTES = 300;
const WEEK_MINUTES = 10_080;
// JSON-RPC errors for requests coder does not take.
const METHOD_NOT_FOUND = -32601;
const IMPLEMENT_PLAN = "Implement the plan.";

/** Sandbox and approvals per mode (spec §4.4); `read` also plans (collaboration mode). */
const POLICIES: Record<
  Mode,
  {
    sandbox: "read-only" | "workspace-write" | "danger-full-access";
    approval: "on-request" | "never";
  }
> = {
  read: { sandbox: "read-only", approval: "on-request" },
  ask: { sandbox: "workspace-write", approval: "on-request" },
  edits: { sandbox: "workspace-write", approval: "on-request" },
  full: { sandbox: "danger-full-access", approval: "never" },
};
const sandboxPolicy = (mode: Mode): NonNullable<TurnStartParams["sandboxPolicy"]> =>
  mode === "full"
    ? { type: "dangerFullAccess" }
    : mode === "read"
      ? { type: "readOnly", networkAccess: false }
      : {
          type: "workspaceWrite",
          writableRoots: [],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        };

const STATUS: Record<string, ItemStatus> = {
  inProgress: "running",
  completed: "done",
  failed: "error",
  declined: "declined",
};
const statusOf = (status: string): ItemStatus => STATUS[status] ?? "done";

/** A command as the user would have typed it: Codex runs it through a login shell. */
function commandOf(command: string, actions: readonly { command?: string }[]) {
  const [only] = actions;
  if (actions.length === 1 && only?.command) return only.command;
  const wrapped =
    /^\S*\/(?:ba|z)?sh -lc '(.*)'$/s.exec(command) ??
    /^\S*\/(?:ba|z)?sh -lc "(.*)"$/s.exec(command);
  return wrapped?.[1] ?? command;
}

/** Codex's file changes: hunks without headers, which coder's diff view needs. */
function patchesOf(
  cwd: string,
  changes: readonly { path: string; kind: { type: string }; diff: string }[],
): FilePatch[] {
  return changes.map((change) => {
    const path = displayPath(cwd, change.path);
    const hunks = change.diff.startsWith("---")
      ? change.diff
      : `--- a/${path}\n+++ b/${path}\n${change.diff}`;
    // An added file comes as its content, not as hunks.
    const patch = /^@@/m.test(hunks)
      ? hunks
      : `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${change.diff.split("\n").filter(Boolean).length} @@\n${change.diff
          .split("\n")
          .filter(Boolean)
          .map((l) => `+${l}`)
          .join("\n")}\n`;
    return { path, patch, ...stats(patch) };
  });
}

/** A Codex thread item as a transcript item; `undefined` for what coder does not show. */
export function itemOf(cwd: string, raw: unknown): Item | undefined {
  const parsed = ThreadItem.safeParse(raw);
  if (!parsed.success) return undefined;
  const item = parsed.data;
  switch (item.type) {
    case "userMessage":
      return undefined;
    case "agentMessage":
      return "text" in item && typeof item.text === "string"
        ? { id: item.id, kind: "message", text: item.text, streaming: false }
        : undefined;
    case "plan":
      return "text" in item && typeof item.text === "string"
        ? { id: item.id, kind: "message", text: item.text, streaming: false }
        : undefined;
    case "reasoning": {
      const text =
        "summary" in item && Array.isArray(item.summary) ? item.summary.join("\n\n") : "";
      return text.trim() ? { id: item.id, kind: "reasoning", text, streaming: false } : undefined;
    }
    case "commandExecution":
      if (!("command" in item) || typeof item.command !== "string" || !("status" in item))
        return undefined;
      return {
        id: item.id,
        kind: "command",
        command: commandOf(
          item.command,
          "commandActions" in item && Array.isArray(item.commandActions) ? item.commandActions : [],
        ),
        cwd: "cwd" in item && typeof item.cwd === "string" ? displayPath(cwd, item.cwd) : undefined,
        output:
          "aggregatedOutput" in item && typeof item.aggregatedOutput === "string"
            ? item.aggregatedOutput
            : "",
        exitCode:
          "exitCode" in item && typeof item.exitCode === "number" ? item.exitCode : undefined,
        status: statusOf(String(item.status)),
      };
    case "fileChange":
      return "changes" in item && Array.isArray(item.changes) && "status" in item
        ? {
            id: item.id,
            kind: "file_change",
            files: patchesOf(cwd, item.changes),
            status: statusOf(String(item.status)),
          }
        : undefined;
    case "collabAgentToolCall":
      return {
        id: item.id,
        kind: "subagent",
        title: "tool" in item && typeof item.tool === "string" ? item.tool : "agent",
        detail: "prompt" in item && typeof item.prompt === "string" ? item.prompt : "",
        tools: 0,
        status: "status" in item ? statusOf(String(item.status)) : "done",
      };
    case "contextCompaction":
      return { id: item.id, kind: "compaction", status: "done" };
    case "exitedReviewMode":
      return "review" in item && typeof item.review === "string"
        ? { id: item.id, kind: "message", text: item.review, streaming: false }
        : undefined;
    default: {
      const record: Record<string, unknown> = { ...item };
      const title = ["query", "tool", "path", "url", "name"]
        .map((k) => record[k])
        .find((v) => typeof v === "string");
      return {
        id: item.id,
        kind: "tool",
        name: item.type,
        title: typeof title === "string" ? title : "",
        input: "",
        output: "",
        status: typeof record.status === "string" ? statusOf(record.status) : "done",
      };
    }
  }
}

export type CodexTransport = {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  reply(id: string | number, result: unknown): void;
  fail(id: string | number, code: number, message: string): void;
  kill(): void;
  exited: Promise<string>;
};
export type CodexDeps = {
  spawn(handlers: RpcHandlers, options: { cwd: string; env: NodeJS.ProcessEnv }): CodexTransport;
  /** The user's `codex`: found on the PATH. */
  codex: () => string | null;
};
export const codexProcess: CodexDeps = {
  spawn(handlers, options) {
    const codex = Bun.which("codex", { PATH: options.env.PATH ?? "" }) ?? "codex";
    const peer = new RpcPeer([codex, "app-server"], options, handlers);
    return {
      request: (method, params) => peer.request(method, params),
      notify: (method, params) => peer.notify(method, params),
      reply: (id, result) => peer.reply(id, result),
      fail: (id, code, message) => peer.fail(id, code, message),
      kill: () => peer.kill(),
      exited: peer.process.exited,
    };
  },
  codex: () => Bun.which("codex"),
};

type Pending = {
  rpc: string | number;
  request: Request;
  answer: (response: Response) => unknown;
};

export class CodexHarness implements Harness {
  readonly id = "codex" as const;
  readonly capabilities = CAPABILITIES;
  private readonly context: HarnessContext;
  private readonly deps: CodexDeps;
  private rpc: CodexTransport | null = null;
  private options: StartOptions = { cwd: "", mode: "ask" };
  private threadId = "";
  private turnId = "";
  private model = "";
  private readonly started = new Set<string>();
  private readonly files = new Map<string, FilePatch[]>();
  private readonly pending = new Map<string, Pending>();
  private plan: string | null = null;
  private skills: { name: string; path: string }[] = [];
  private closed = false;
  private next = 0;

  constructor(context: HarnessContext, deps: CodexDeps = codexProcess) {
    this.context = context;
    this.deps = deps;
  }

  private emit(event: HarnessEvent) {
    this.context.emit(event);
  }
  private transport() {
    if (!this.rpc) throw new Error("Codex is not running");
    return this.rpc;
  }

  async start(options: StartOptions) {
    this.options = options;
    this.model = options.model ?? "";
    if (!this.deps.codex())
      throw new Error(
        "codex is not on the PATH: install Codex (https://developers.openai.com/codex)",
      );
    const rpc = this.deps.spawn(
      {
        onNotification: (method, params) => this.notification(method, params),
        onRequest: (id, method, params) => this.request(id, method, params),
      },
      { cwd: options.cwd, env: this.context.env },
    );
    this.rpc = rpc;
    void rpc.exited.then((reason) => {
      if (this.rpc !== rpc || this.closed) return;
      this.rpc = null;
      this.cancelPending();
      this.emit({ type: "exited", reason });
    });
    const initialized = InitializeResponse.safeParse(
      await rpc.request("initialize", {
        // An honest name: Codex records it in compliance logs.
        clientInfo: {
          name: this.options.client ?? "luciole-coder",
          title: `${this.options.client ?? "luciole-coder"} (luciole)`,
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true, requestAttestation: false },
      } satisfies InitializeParams),
    );
    rpc.notify("initialized");
    const version = initialized.success
      ? /\/([\d.]+)/.exec(initialized.data.userAgent)?.[1]
      : undefined;
    const account = AccountResponse.safeParse(
      await rpc.request("account/read", { refreshToken: false }),
    );
    if (account.success && !account.data.account && account.data.requiresOpenaiAuth)
      throw new Error("Codex is not signed in: run `codex login` in a terminal");
    const signedIn = account.success ? account.data.account : null;
    this.emit({
      type: "info.updated",
      info: {
        ...(version ? { version } : {}),
        ...(signedIn
          ? {
              account: [signedIn.email ?? signedIn.type, signedIn.planType]
                .filter(Boolean)
                .join(" · "),
            }
          : {}),
        ...(version && version !== PROTOCOL_VERSION
          ? {
              warnings: [
                `coder speaks the app-server protocol of codex ${PROTOCOL_VERSION}; this is ${version}`,
              ],
            }
          : {}),
      },
    });
    const resume = options.resume === true ? (await this.listSessions())[0]?.id : options.resume;
    if (resume) await this.resume(resume);
    else await this.newSession();
  }

  private async open(
    method: "thread/start" | "thread/resume",
    params: ThreadStartParams | ThreadResumeParams,
  ) {
    const response = ThreadResponse.parse(await this.transport().request(method, params));
    this.threadId = response.thread.id;
    return response;
  }

  async newSession() {
    const policy = POLICIES[this.options.mode];
    const response = await this.open("thread/start", {
      cwd: this.options.cwd,
      ...(this.options.instructions ? { developerInstructions: this.options.instructions } : {}),
      approvalPolicy: policy.approval,
      sandbox: policy.sandbox,
      ...(this.options.model ? { model: this.options.model } : {}),
    } satisfies ThreadStartParams);
    this.model = response.model ?? this.model;
    this.emit({
      type: "info.updated",
      info: {
        sessionId: this.threadId,
        mode: this.options.mode,
        ...(this.model ? { model: this.model } : {}),
      },
    });
  }

  async resume(id: string) {
    const policy = POLICIES[this.options.mode];
    const response = await this.open("thread/resume", {
      threadId: id,
      ...(this.options.instructions ? { developerInstructions: this.options.instructions } : {}),
      approvalPolicy: policy.approval,
      sandbox: policy.sandbox,
      ...(this.options.model ? { model: this.options.model } : {}),
    } satisfies ThreadResumeParams);
    this.model = response.model ?? this.model;
    const items = response.thread.turns
      .flatMap((turn) => turn.items)
      .flatMap((raw) => {
        const item = itemOf(this.options.cwd, raw);
        const user = ThreadItem.safeParse(raw);
        if (item) return [item];
        // User messages are part of a resumed transcript.
        if (user.success && user.data.type === "userMessage") {
          const record: Record<string, unknown> = { ...user.data };
          const content = Array.isArray(record.content) ? record.content : [];
          const text = content.flatMap((c: unknown) =>
            typeof c === "object" && c !== null && "text" in c && typeof c.text === "string"
              ? [c.text]
              : [],
          );
          return text.length
            ? [{ id: user.data.id, kind: "user" as const, text: text.join("\n") }]
            : [];
        }
        return [];
      });
    this.emit({ type: "history", items });
    this.emit({
      type: "info.updated",
      info: {
        sessionId: this.threadId,
        ...(response.thread.name ? { title: response.thread.name } : {}),
        ...(this.model ? { model: this.model } : {}),
      },
    });
  }

  private notification(method: string, params: unknown) {
    switch (method) {
      case "turn/started": {
        const turn = TurnNotification.safeParse(params);
        if (turn.success) this.turnId = turn.data.turn.id;
        this.emit({ type: "turn.started" });
        return;
      }
      case "turn/completed": {
        const turn = TurnNotification.safeParse(params);
        if (!turn.success) return;
        const { status, error } = turn.data.turn;
        this.turnId = "";
        this.emit(
          status === "interrupted"
            ? { type: "turn.completed", status: "interrupted" }
            : status === "failed"
              ? {
                  type: "turn.completed",
                  status: "failed",
                  error: error?.message ?? "The turn failed",
                }
              : { type: "turn.completed", status: "completed" },
        );
        // A plan made in plan mode: its review is coder's own request.
        if (this.plan && status === "completed") this.reviewPlan(this.plan);
        this.plan = null;
        return;
      }
      case "item/started":
      case "item/completed":
        return this.item(method === "item/completed", params);
      case "item/agentMessage/delta":
      case "item/plan/delta":
        return this.delta(params, "message", "text");
      case "item/reasoning/summaryTextDelta":
        return this.delta(params, "reasoning", "text");
      case "item/commandExecution/outputDelta":
        return this.delta(params, "command", "output");
      case "turn/plan/updated": {
        const plan = PlanUpdated.safeParse(params);
        if (plan.success)
          this.emit({
            type: "plan.updated",
            steps: plan.data.plan.map((s) => ({
              text: s.step,
              status:
                s.status === "completed"
                  ? "completed"
                  : s.status === "inProgress"
                    ? "in_progress"
                    : "pending",
            })),
          });
        return;
      }
      case "thread/tokenUsage/updated": {
        const usage = TokenUsage.safeParse(params);
        if (!usage.success) return;
        const { total, last, modelContextWindow } = usage.data.tokenUsage;
        this.emit({
          type: "usage.updated",
          usage: {
            ...(modelContextWindow
              ? { context: { used: last.totalTokens, window: modelContextWindow } }
              : {}),
            tokens: { input: total.inputTokens, output: total.outputTokens },
          },
        });
        return;
      }
      case "account/rateLimits/updated": {
        const limits = RateLimits.safeParse(params);
        if (!limits.success) return;
        const windows = [limits.data.rateLimits.primary, limits.data.rateLimits.secondary].flatMap(
          (w) => (w ? [w] : []),
        );
        const at = (minutes: number) => windows.find((w) => w.windowDurationMins === minutes);
        const five = at(FIVE_HOURS_MINUTES);
        const week = at(WEEK_MINUTES);
        const reset = (five ?? week)?.resetsAt;
        this.emit({
          type: "usage.updated",
          usage: {
            limits: {
              ...(five ? { fiveHour: five.usedPercent } : {}),
              ...(week ? { weekly: week.usedPercent } : {}),
              ...(reset ? { resetsAt: reset * SECOND_MS } : {}),
            },
          },
        });
        return;
      }
      case "error": {
        const error = ErrorNotification.safeParse(params);
        if (error.success)
          this.emit({
            type: "notice",
            level: error.data.willRetry ? "warn" : "error",
            text: `Codex: ${error.data.error.message}`,
          });
        return;
      }
      case "serverRequest/resolved": {
        const resolved = Resolved.safeParse(params);
        if (!resolved.success) return;
        for (const [id, pending] of this.pending)
          if (String(pending.rpc) === String(resolved.data.requestId)) {
            this.pending.delete(id);
            this.emit({ type: "request.resolved", id });
          }
        return;
      }
      case "warning":
      case "configWarning":
      case "deprecationNotice":
      case "model/rerouted": {
        const message = Message.safeParse(params);
        if (message.success)
          this.emit({ type: "notice", level: "warn", text: `Codex: ${message.data.message}` });
        return;
      }
      default:
        return;
    }
  }

  private item(completed: boolean, params: unknown) {
    const notification = ItemNotification.safeParse(params);
    if (!notification.success) return;
    const raw = ThreadItem.safeParse(notification.data.item);
    if (
      raw.success &&
      raw.data.type === "plan" &&
      completed &&
      "text" in raw.data &&
      typeof raw.data.text === "string"
    )
      this.plan = raw.data.text;
    const item = itemOf(this.options.cwd, notification.data.item);
    if (!item) return;
    if (item.kind === "file_change") this.files.set(item.id, [...item.files]);
    const streaming = (item.kind === "message" || item.kind === "reasoning") && !completed;
    const shown: Item =
      streaming && (item.kind === "message" || item.kind === "reasoning")
        ? { ...item, streaming: true }
        : item;
    if (!completed) {
      this.started.add(item.id);
      this.emit({ type: "item.started", item: { ...shown, startedAt: Date.now() } });
    } else {
      this.emit({ type: "item.completed", item: { ...shown, endedAt: Date.now() } });
    }
  }

  private delta(
    params: unknown,
    kind: "message" | "reasoning" | "command",
    field: "text" | "output",
  ) {
    const delta = Delta.safeParse(params);
    if (!delta.success) return;
    const { itemId, delta: text } = delta.data;
    // Reasoning summaries start with their first words: the item is created then.
    if (!this.started.has(itemId) && kind !== "command") {
      this.started.add(itemId);
      this.emit({
        type: "item.started",
        item: { id: itemId, kind, text: "", streaming: true, startedAt: Date.now() },
      });
    }
    this.emit({ type: "item.delta", id: itemId, field, delta: text });
  }

  /** A request from Codex: a pending request coder answers once. */
  private request(rpc: string | number, method: string, params: unknown) {
    const id = `codex-${rpc}-${++this.next}`;
    const openedAt = Date.now();
    const transport = this.rpc;
    if (!transport) return;
    const open = (request: Request, answer: (response: Response) => unknown) => {
      this.pending.set(id, {
        rpc,
        request,
        answer: (response) => transport.reply(rpc, answer(response)),
      });
      this.emit({ type: "request.opened", request });
    };
    switch (method) {
      case "item/commandExecution/requestApproval": {
        const asked = CommandApproval.safeParse(params);
        if (!asked.success) return transport.fail(rpc, METHOD_NOT_FOUND, "Unreadable approval");
        const amendment = asked.data.proposedExecpolicyAmendment ?? undefined;
        const decisions: Decision[] = [
          "once",
          "session",
          ...(amendment?.length ? (["always"] as const) : []),
          "deny",
        ];
        return open(
          {
            id,
            openedAt,
            kind: "approval",
            title: "Run a command",
            command: commandOf(asked.data.command ?? "", asked.data.commandActions ?? []),
            detail: asked.data.reason ?? undefined,
            decisions,
          },
          (response): CommandExecutionRequestApprovalResponse => ({
            decision:
              response.kind === "cancel"
                ? "cancel"
                : response.kind !== "approval" || response.decision === "deny"
                  ? "decline"
                  : response.decision === "session"
                    ? "acceptForSession"
                    : response.decision === "always" && amendment
                      ? { acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } }
                      : "accept",
          }),
        );
      }
      case "item/fileChange/requestApproval": {
        const asked = FileApproval.safeParse(params);
        if (!asked.success) return transport.fail(rpc, METHOD_NOT_FOUND, "Unreadable approval");
        // Auto edits: file changes need no one's word.
        if (this.options.mode === "edits" || this.options.mode === "full")
          return transport.reply(rpc, {
            decision: "accept",
          } satisfies FileChangeRequestApprovalResponse);
        return open(
          {
            id,
            openedAt,
            kind: "approval",
            title: "Change files",
            files: this.files.get(asked.data.itemId) ?? [],
            detail: asked.data.reason ?? undefined,
            decisions: ["once", "session", "deny"],
          },
          (response): FileChangeRequestApprovalResponse => ({
            decision:
              response.kind === "cancel"
                ? "cancel"
                : response.kind !== "approval" || response.decision === "deny"
                  ? "decline"
                  : response.decision === "session"
                    ? "acceptForSession"
                    : "accept",
          }),
        );
      }
      case "item/tool/requestUserInput": {
        const asked = UserInputRequest.safeParse(params);
        if (!asked.success) return transport.fail(rpc, METHOD_NOT_FOUND, "Unreadable question");
        const questions = asked.data.questions;
        return open(
          {
            id,
            openedAt,
            kind: "question",
            questions: questions.map((q) => ({
              question: q.question,
              header: q.header,
              options: (q.options ?? []).map((o) => ({
                label: o.label,
                description: o.description ?? undefined,
              })),
            })),
          },
          (response): ToolRequestUserInputResponse => ({
            answers:
              response.kind === "question"
                ? Object.fromEntries(
                    questions.map((q, i) => [q.id, { answers: [...(response.answers[i] ?? [])] }]),
                  )
                : {},
          }),
        );
      }
      default:
        // Elicitations, extra permissions, dynamic tools: not coder's to grant yet.
        this.emit({
          type: "notice",
          level: "warn",
          text: `Codex asked for ${method}, which coder does not handle: declined`,
        });
        return transport.fail(rpc, METHOD_NOT_FOUND, `coder does not handle ${method}`);
    }
  }

  /** Plan mode ends with a plan: approving it leaves plan mode and implements it. */
  private reviewPlan(plan: string) {
    const id = `codex-plan-${++this.next}`;
    this.pending.set(id, {
      rpc: id,
      request: { id, openedAt: Date.now(), kind: "plan_review", plan },
      answer: (response) => {
        if (response.kind !== "plan_review") return;
        if (response.approve) {
          this.options = { ...this.options, mode: "ask" };
          this.emit({ type: "info.updated", info: { mode: "ask" } });
          void this.send({ text: IMPLEMENT_PLAN }).catch(() => {});
        } else if (response.feedback) void this.send({ text: response.feedback }).catch(() => {});
      },
    });
    this.emit({
      type: "request.opened",
      request: { id, openedAt: Date.now(), kind: "plan_review", plan },
    });
  }

  private cancelPending() {
    for (const [id] of this.pending) this.emit({ type: "request.resolved", id });
    this.pending.clear();
  }

  private input(text: string): CodexInput[] {
    // `/skill …` from the completion, or `$skill …` as Codex writes it: the skill joins.
    const named = /^[/$]([\w.-]+)(?:\s|$)/.exec(text)?.[1];
    const skill = named ? this.skills.find((s) => s.name === named) : undefined;
    const body = skill ? text.replace(/^\//, "$") : text;
    return [
      { type: "text", text: body, text_elements: [] },
      ...(skill ? [{ type: "skill" as const, name: skill.name, path: skill.path }] : []),
    ];
  }

  async send({ text }: UserInput) {
    const mode = this.options.mode;
    const policy = POLICIES[mode];
    const response = TurnStartResponse.safeParse(
      await this.transport().request("turn/start", {
        threadId: this.threadId,
        input: this.input(text),
        approvalPolicy: policy.approval,
        sandboxPolicy: sandboxPolicy(mode),
        ...(this.options.model ? { model: this.options.model } : {}),
        ...(this.options.effort ? { effort: this.options.effort } : {}),
        ...(this.model
          ? {
              collaborationMode: {
                mode: mode === "read" ? "plan" : "default",
                settings: {
                  model: this.options.model ?? this.model,
                  reasoning_effort: this.options.effort ?? null,
                  developer_instructions: null,
                },
              },
            }
          : {}),
      } satisfies TurnStartParams),
    );
    if (response.success) this.turnId = response.data.turn.id;
  }

  async steer({ text }: UserInput) {
    await this.transport().request("turn/steer", {
      threadId: this.threadId,
      input: this.input(text),
      expectedTurnId: this.turnId,
    } satisfies TurnSteerParams);
  }

  async interrupt() {
    if (!this.turnId) return;
    await this.transport().request("turn/interrupt", {
      threadId: this.threadId,
      turnId: this.turnId,
    } satisfies TurnInterruptParams);
  }

  async respond(request: Request, response: Response) {
    const pending = this.pending.get(request.id);
    if (!pending) throw new Error("Codex no longer waits for this answer");
    this.pending.delete(request.id);
    pending.answer(response);
  }

  async setModel(model: string, effort?: string) {
    // Turn overrides persist: the next turn carries them.
    this.options = { ...this.options, model, ...(effort !== undefined ? { effort } : {}) };
    this.model = model;
  }

  async setMode(mode: Mode) {
    this.options = { ...this.options, mode };
  }

  async compact() {
    await this.transport().request("thread/compact/start", {
      threadId: this.threadId,
    } satisfies ThreadCompactStartParams);
  }

  async listSessions(): Promise<readonly SessionSummary[]> {
    const list = ThreadList.safeParse(
      await this.transport().request("thread/list", {
        cwd: this.options.cwd,
        limit: SESSIONS_LISTED,
      } satisfies ThreadListParams),
    );
    return list.success
      ? list.data.data.map((t) => ({
          id: t.id,
          title: t.name || t.preview || t.id,
          updatedAt: (t.updatedAt ?? 0) * SECOND_MS,
        }))
      : [];
  }

  async models(): Promise<readonly ModelInfo[]> {
    const list = ModelList.safeParse(
      await this.transport().request("model/list", {
        limit: MODELS_LISTED,
      } satisfies ModelListParams),
    );
    return list.success
      ? list.data.data
          .filter((m) => !m.hidden)
          .map((m) => ({
            id: m.id,
            label: m.displayName,
            efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort),
            defaultEffort: m.defaultReasoningEffort ?? undefined,
          }))
      : [];
  }

  async commands(): Promise<readonly CommandInfo[]> {
    const list = SkillsList.safeParse(
      await this.transport().request("skills/list", {
        cwds: [this.options.cwd],
      } satisfies SkillsListParams),
    );
    if (!list.success) return [];
    this.skills = list.data.data.flatMap((entry) =>
      entry.skills.filter((s) => s.enabled !== false),
    );
    return this.skills.map((s) => ({
      name: s.name,
      description:
        list.data.data.flatMap((e) => e.skills).find((k) => k.name === s.name)?.description ?? "",
      source: "harness" as const,
    }));
  }

  async close() {
    this.closed = true;
    this.cancelPending();
    this.rpc?.kill();
    this.rpc = null;
  }
}
