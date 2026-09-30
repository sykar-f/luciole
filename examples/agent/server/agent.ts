import "server-only";
import type { AgentState, SendResult, Snapshot } from "../components/model";
import { config } from "./config";
import { PiProcess } from "./pi";
import { Messages, State, textOf, type Event } from "./protocol";
import { Transcript } from "./transcript";

// Streaming deltas arrive by the dozen per second: subscribers get at most one snapshot
// per interval, always the latest.
const SNAPSHOT_INTERVAL_MS = 50;
// A model id without a provider means the ChatGPT subscription.
const PROVIDER = "openai-codex";
const TOOLS = "read,bash,edit,write";

const model = config.model.includes("/") ? config.model : `${PROVIDER}/${config.model}`;

/**
 * The single agent of this Server: one pi process, started on first use and again after
 * it exits, and the transcript its events build. Every Client watching the Server sees
 * the same conversation.
 */
class Agent {
  private pi: PiProcess | null = null;
  private starting: Promise<PiProcess> | null = null;
  private readonly transcript = new Transcript();
  private state: AgentState = "stopped";
  private queued: string[] = [];
  private sessionId: string | null = null;
  private error: string | null = null;
  private version = 0;
  private readonly listeners = new Set<() => void>();

  private changed() {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  snapshot(): Snapshot {
    return {
      version: this.version,
      state: this.state,
      model,
      thinking: config.thinking,
      cwd: config.cwd,
      sessionId: this.sessionId,
      blocks: this.transcript.blocks,
      queued: this.queued,
      usage: this.transcript.usage,
      error: this.error,
    };
  }

  /** Starts pi if needed; resolves once its state and past messages are loaded. */
  start(): Promise<PiProcess> {
    this.starting ??= this.spawn();
    return this.starting;
  }

  private async spawn() {
    this.state = "starting";
    this.error = null;
    this.changed();
    const pi = new PiProcess(
      [
        config.pi,
        "--mode",
        "rpc",
        "--model",
        model,
        "--thinking",
        config.thinking,
        // The latest session of this working directory continues: a rebuild of
        // `luciole dev` restarts the Server, not the conversation.
        "--session-dir",
        config.sessionDir,
        "--continue",
        // Extensions may open dialogs, skills and templates add context: none of them
        // belong to this demo, which keeps pi's four core tools.
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--tools",
        TOOLS,
      ],
      config.cwd,
      (event) => this.onEvent(event),
    );
    this.pi = pi;
    void pi.exited.then((reason) => {
      if (this.pi !== pi) return;
      this.pi = null;
      this.starting = null;
      this.transcript.settle();
      this.state = "stopped";
      this.error = reason;
      this.changed();
    });
    const [state, messages] = await Promise.all([
      pi.send({ type: "get_state" }),
      pi.send({ type: "get_messages" }),
    ]);
    const parsed = State.safeParse(state.data);
    const history = Messages.safeParse(messages.data);
    if (history.success) this.transcript.load(history.data.messages);
    if (parsed.success) {
      this.sessionId = parsed.data.sessionId ?? null;
      this.state = parsed.data.isStreaming ? "running" : "idle";
    } else if (this.pi === pi) this.error = state.error ?? "pi did not report its state";
    this.changed();
    return pi;
  }

  private onEvent(event: Event) {
    const t = this.transcript;
    switch (event.type) {
      case "agent_start":
        this.state = "running";
        break;
      case "agent_settled":
        t.settle();
        this.state = "idle";
        break;
      case "message_start":
        if (event.message.role === "user" && "content" in event.message)
          t.user(event.message.content);
        else if (event.message.role === "assistant") t.assistantStart();
        break;
      case "message_end":
        if (event.message.role === "assistant" && "stopReason" in event.message)
          t.assistantEnd(event.message, { aborting: this.state === "aborting" });
        break;
      case "message_update":
        t.assistantEvent(event.assistantMessageEvent);
        break;
      case "tool_execution_start":
        t.toolStart(event.toolCallId, event.toolName, event.args);
        break;
      case "tool_execution_update":
        t.toolOutput(event.toolCallId, textOf(event.partialResult.content));
        break;
      case "tool_execution_end":
        t.toolEnd(event.toolCallId, textOf(event.result.content), event.isError);
        break;
      case "queue_update":
        this.queued = [...event.steering, ...event.followUp];
        break;
      case "auto_retry_start":
        t.notice("info", `Retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`);
        break;
      case "auto_retry_end":
        if (!event.success) t.notice("error", event.finalError ?? "Retries exhausted");
        break;
      case "compaction_start":
        t.notice("info", "Compacting the context…");
        break;
      case "extension_error":
        t.notice("error", event.error);
        break;
      default:
        return;
    }
    this.changed();
  }

  /** A prompt while idle, or a steering message while the agent works. */
  async prompt(message: string): Promise<SendResult> {
    const pi = await this.start();
    const busy = this.state === "running" || this.state === "aborting";
    this.error = null;
    const response = await pi.send({
      type: "prompt",
      message,
      ...(busy ? { streamingBehavior: "steer" } : {}),
    });
    if (response.success) return { ok: true };
    this.error = response.error ?? "Prompt refused";
    this.changed();
    return { ok: false, error: this.error };
  }

  async abort(): Promise<SendResult> {
    const pi = this.pi;
    if (!pi || (this.state !== "running" && this.state !== "aborting")) return { ok: true };
    this.state = "aborting";
    this.changed();
    // Queued steering would start a new turn right after the abort.
    await pi.send({ type: "clear_queue" });
    const response = await pi.send({ type: "abort" });
    return response.success ? { ok: true } : { ok: false, error: response.error ?? "Abort failed" };
  }

  async newSession(): Promise<SendResult> {
    const pi = await this.start();
    await this.abort();
    const response = await pi.send({ type: "new_session" });
    if (!response.success) return { ok: false, error: response.error ?? "New session refused" };
    const state = State.safeParse((await pi.send({ type: "get_state" })).data);
    this.transcript.reset();
    this.queued = [];
    this.error = null;
    this.sessionId = state.success ? (state.data.sessionId ?? null) : null;
    this.state = "idle";
    this.changed();
    return { ok: true };
  }

  /**
   * Snapshots for one subscriber: the current one at once, then the latest after each
   * change. A hand-written iterator rather than a generator: when the Client leaves,
   * Flight calls `throw()` while the subscriber waits for a change that may never come,
   * and only an iterator can end that wait.
   */
  subscribe(): AsyncIterableIterator<Snapshot> {
    let seen = -1;
    let last = 0;
    let closed = false;
    let wake: (() => void) | null = null;
    const listener = () => wake?.();
    this.listeners.add(listener);
    const close = (): IteratorResult<Snapshot> => {
      closed = true;
      this.listeners.delete(listener);
      wake?.();
      return { done: true, value: undefined };
    };
    const iterator: AsyncIterableIterator<Snapshot> = {
      [Symbol.asyncIterator]: () => iterator,
      next: async () => {
        while (!closed && this.version === seen)
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        const wait = last + SNAPSHOT_INTERVAL_MS - Date.now();
        if (wait > 0) await Bun.sleep(wait);
        if (closed) return { done: true, value: undefined };
        seen = this.version;
        last = Date.now();
        return { done: false, value: this.snapshot() };
      },
      return: async () => close(),
      throw: async () => close(),
    };
    return iterator;
  }

  kill() {
    this.pi?.kill();
  }
}

export const agent = new Agent();
// pi reads stdin until it closes; kill it explicitly so a restarted Server never
// leaves a second agent running on the same session.
process.on("exit", () => agent.kill());
