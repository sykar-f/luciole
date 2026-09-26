import "server-only";
import {
  HARNESS_NAMES,
  type Capabilities,
  type Fields,
  type HarnessId,
  type Info,
  type Item,
  type Mode,
  type PlanStep,
  type Request,
  type RequestState,
  type Response,
  type Result,
  type SessionState,
  type SessionSummary,
  type Snapshot,
  type Update,
  type Usage,
} from "../components/model";
import { createHarness } from "./adapters";
import type { Harness, HarnessEvent } from "./adapters/types";
import { config } from "./config";
import { pickHarness } from "./detect";
import { rememberLaunch, rememberedSession } from "./launches";

// Streaming deltas arrive by the dozen per second: a subscriber gets at most one update
// per interval, holding everything that changed since the previous one.
const UPDATE_INTERVAL_MS = 50;
// The transcript keeps its latest items; older ones leave the Client too.
const MAX_ITEMS = 400;
// A command's output keeps its end: what a long build printed last is what matters.
const OUTPUT_KEPT = 12_000;
// Removals remembered for subscribers that are behind; older ones get a snapshot.
const REMOVALS_KEPT = 1000;
// Listing sessions reads the harness's history: bounded below the action timeout.
const LIST_TIMEOUT_MS = 8000;

const NO_CAPABILITIES: Capabilities = {
  steer: false,
  models: false,
  effort: false,
  modes: [],
  compact: false,
  resume: false,
  newSession: false,
  planMode: false,
  images: false,
};

type FieldKey = keyof Fields;
const clip = (text: string) => (text.length > OUTPUT_KEPT ? text.slice(-OUTPUT_KEPT) : text);
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const failed = (error: unknown): Result => ({ ok: false, error: messageOf(error) });
const within = <T>(promise: Promise<T>, ms: number, what: string) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} took too long`)), ms),
    ),
  ]);

/**
 * The one agent session of this Server (one Server per launch): the harness it drives,
 * and everything the Client shows, rebuilt from the harness's events. Clients follow it
 * through `subscribe()`: a snapshot, then patches of what changed.
 */
class Session {
  private harness: Harness | null = null;
  private starting: Promise<void> | null = null;
  private state: SessionState = "stopped";
  private info: Info = {
    harness: config.harness ?? "fake",
    poweredBy: HARNESS_NAMES[config.harness ?? "fake"],
    model: config.model,
    effort: config.effort,
    mode: config.mode,
    cwd: config.cwd,
    warnings: [],
  };
  private readonly order: string[] = [];
  private readonly byId = new Map<string, Item>();
  private readonly requests = new Map<string, Request>();
  private readonly answered = new Map<string, Response>();
  private plan: readonly PlanStep[] = [];
  private usage: Usage = {};
  private queued: readonly string[] = [];
  private error: string | null = null;
  private capabilities: Capabilities = NO_CAPABILITIES;
  private models: Fields["models"] = [];
  private commands: Fields["commands"] = [];
  // Change tracking: every change takes a new revision; subscribers send what is newer.
  private revision = 0;
  private readonly itemRevision = new Map<string, number>();
  private readonly fieldRevision = new Map<FieldKey, number>();
  private removals: { id: string; revision: number }[] = [];
  private resetRevision = 0;
  private readonly listeners = new Set<() => void>();
  private next = 0;

  private changed() {
    for (const listener of this.listeners) listener();
  }
  private touch(...keys: FieldKey[]) {
    this.revision++;
    for (const key of keys) this.fieldRevision.set(key, this.revision);
    this.changed();
  }
  private put(item: Item) {
    this.revision++;
    if (!this.byId.has(item.id)) this.order.push(item.id);
    this.byId.set(item.id, item);
    this.itemRevision.set(item.id, this.revision);
    while (this.order.length > MAX_ITEMS) {
      const oldest = this.order.shift();
      if (oldest === undefined) break;
      this.byId.delete(oldest);
      this.itemRevision.delete(oldest);
      this.removals.push({ id: oldest, revision: this.revision });
    }
    if (this.removals.length > REMOVALS_KEPT) {
      this.removals = this.removals.slice(-REMOVALS_KEPT);
      this.resetRevision = this.revision;
    }
    this.changed();
  }
  private reset(items: readonly Item[]) {
    this.order.length = 0;
    this.byId.clear();
    this.itemRevision.clear();
    this.removals = [];
    for (const item of items.slice(-MAX_ITEMS)) {
      this.order.push(item.id);
      this.byId.set(item.id, item);
    }
    this.revision++;
    this.resetRevision = this.revision;
    this.changed();
  }
  private notice(level: "info" | "warn" | "error", text: string) {
    this.put({ id: `notice-${++this.next}`, kind: "notice", level, text });
  }

  snapshot(): Snapshot {
    return {
      state: this.state,
      info: this.info,
      items: this.order.flatMap((id) => {
        const item = this.byId.get(id);
        return item ? [item] : [];
      }),
      requests: [...this.requests.values()],
      plan: this.plan,
      usage: this.usage,
      queued: this.queued,
      error: this.error,
      capabilities: this.capabilities,
      models: this.models,
      commands: this.commands,
    };
  }

  private fields(keys: readonly FieldKey[]): Partial<Fields> {
    const all = this.snapshot();
    const out: Partial<Fields> = {};
    for (const key of keys) Object.assign(out, { [key]: all[key] });
    return out;
  }

  /** Starts the harness once; the page's render calls it, so it boots with the screen. */
  start(): Promise<void> {
    this.starting ??= this.boot().catch((error: unknown) => {
      this.starting = null;
      this.state = "stopped";
      this.error = messageOf(error);
      this.touch("state", "error");
    });
    return this.starting;
  }

  private async boot() {
    this.state = "starting";
    this.error = null;
    this.touch("state", "error");
    const picked = await pickHarness(config.harness);
    this.info = {
      ...this.info,
      harness: picked.id,
      poweredBy: HARNESS_NAMES[picked.id],
      version: picked.version,
      account: picked.account,
      warnings: picked.warnings,
    };
    this.touch("info");
    if (!picked.ready)
      throw new Error(
        `${HARNESS_NAMES[picked.id]} is not ready${picked.fix ? `: ${picked.fix}` : ""}`,
      );
    const harness = createHarness(picked.id, {
      emit: (event) => this.apply(harness, event),
      env: process.env,
    });
    this.harness = harness;
    this.capabilities = harness.capabilities;
    this.touch("capabilities");
    // An explicit --resume wins; otherwise this launch's own session, after a restart of
    // its Server (a rebuild in development), continues.
    const resume = config.resume ?? (await rememberedSession(config.launch, picked.id));
    await harness.start({
      cwd: config.cwd,
      mode: config.mode,
      model: config.model,
      effort: config.effort,
      resume,
    });
    if (this.state === "starting") this.state = "idle";
    this.touch("state");
    void this.catalog(harness);
  }

  /** Models and commands, when the harness has them: after start, never in its way. */
  private async catalog(harness: Harness) {
    const [models, commands] = await Promise.all([
      harness.models().catch(() => []),
      harness.commands().catch(() => []),
    ]);
    if (this.harness !== harness) return;
    this.models = models;
    this.commands = commands;
    this.touch("models", "commands");
  }

  private settle(status: "interrupted" | "failed" | "completed") {
    for (const id of this.order) {
      const item = this.byId.get(id);
      if (!item) continue;
      if ((item.kind === "message" || item.kind === "reasoning") && item.streaming)
        this.put({ ...item, streaming: false });
      else if ("status" in item && item.status === "running")
        this.put({ ...item, status: status === "completed" ? "done" : "error" });
    }
  }

  private apply(harness: Harness, event: HarnessEvent) {
    if (this.harness !== harness) return;
    switch (event.type) {
      case "turn.started":
        this.state = "running";
        this.error = null;
        this.touch("state", "error");
        return;
      case "turn.completed":
        this.settle(event.status);
        if (event.status === "failed" && event.error) {
          this.error = event.error;
          this.notice("error", event.error);
        } else if (event.status === "interrupted") this.notice("info", "Interrupted");
        this.state = "idle";
        this.touch("state", "error");
        void this.dequeue();
        return;
      case "item.started":
      case "item.completed":
        this.put(
          event.item.kind === "command" || event.item.kind === "tool"
            ? { ...event.item, output: clip(event.item.output) }
            : event.item,
        );
        return;
      case "item.delta": {
        const item = this.byId.get(event.id);
        if (!item) return;
        if (event.field === "text" && (item.kind === "message" || item.kind === "reasoning"))
          this.put({ ...item, text: item.text + event.delta });
        else if (event.field === "output" && (item.kind === "command" || item.kind === "tool"))
          this.put({ ...item, output: clip(item.output + event.delta) });
        return;
      }
      case "history":
        this.reset(event.items);
        return;
      case "plan.updated":
        this.plan = event.steps;
        this.touch("plan");
        return;
      case "request.opened":
        if (this.answered.has(event.request.id)) return;
        this.requests.set(event.request.id, event.request);
        this.touch("requests");
        return;
      case "request.resolved":
        if (this.requests.delete(event.id)) this.touch("requests");
        return;
      case "usage.updated":
        this.usage = { ...this.usage, ...event.usage };
        this.touch("usage");
        return;
      case "info.updated":
        this.info = { ...this.info, ...event.info };
        this.touch("info");
        if (event.info.sessionId)
          void rememberLaunch(config.launch, this.info.harness, event.info.sessionId);
        return;
      case "queue.updated":
        this.queued = event.queued;
        this.touch("queued");
        return;
      case "notice":
        this.notice(event.level, event.text);
        return;
      case "exited":
        this.settle("interrupted");
        this.harness = null;
        this.starting = null;
        this.state = "stopped";
        this.error = event.reason;
        if (this.requests.size) this.requests.clear();
        this.touch("state", "error", "requests");
        return;
    }
  }

  private async ready() {
    await this.start();
    if (!this.harness) throw new Error(this.error ?? "The harness is not running");
    return this.harness;
  }

  private async attempt(call: (harness: Harness) => Promise<void>): Promise<Result> {
    try {
      await call(await this.ready());
      return { ok: true };
    } catch (error: unknown) {
      return failed(error);
    }
  }

  /**
   * A message: a new turn when idle; while a turn runs, injected into it when the
   * harness can steer, else queued for its end. `queue` always waits for the end.
   */
  async send(text: string, { queue = false }: { queue?: boolean } = {}): Promise<Result> {
    const busy = this.state === "running" || this.state === "interrupting";
    if (busy && (queue || !this.capabilities.steer)) {
      this.queued = [...this.queued, text];
      this.touch("queued");
      return { ok: true };
    }
    return this.attempt(async (harness) => {
      this.put({ id: `user-${++this.next}`, kind: "user", text, startedAt: Date.now() });
      if (busy) await harness.steer({ text });
      else {
        this.state = "running";
        this.touch("state");
        await harness.send({ text });
      }
    });
  }

  private async dequeue() {
    const [first, ...rest] = this.queued;
    if (first === undefined || this.state !== "idle") return;
    this.queued = rest;
    this.touch("queued");
    const sent = await this.send(first);
    if (!sent.ok) this.notice("error", `Queued message not sent: ${sent.error}`);
  }

  async interrupt(): Promise<Result> {
    if (this.state !== "running") return { ok: true };
    this.state = "interrupting";
    this.touch("state");
    return this.attempt((harness) => harness.interrupt());
  }

  /**
   * Answers a request, once: a second answer to the same id (a retry after a lost
   * response) is acknowledged and never reaches the harness again.
   */
  async respond(id: string, response: Response): Promise<Result> {
    if (this.answered.has(id)) return { ok: true };
    const request = this.requests.get(id);
    if (!request) return { ok: false, error: "This request is no longer pending" };
    const harness = this.harness;
    if (!harness) return { ok: false, error: "The harness is not running" };
    this.answered.set(id, response);
    this.requests.delete(id);
    this.touch("requests");
    try {
      await harness.respond(request, response);
      return { ok: true };
    } catch (error: unknown) {
      this.notice("error", `The answer did not reach ${this.info.poweredBy}: ${messageOf(error)}`);
      return failed(error);
    }
  }

  requestState(id: string): RequestState {
    const response = this.answered.get(id);
    if (response) return { state: "answered", response };
    return this.requests.has(id) ? { state: "pending" } : { state: "gone" };
  }

  async setModel(model: string, effort?: string): Promise<Result> {
    const result = await this.attempt((harness) => harness.setModel(model, effort));
    if (result.ok) {
      this.info = { ...this.info, model, effort: effort ?? this.info.effort };
      this.touch("info");
    }
    return result;
  }

  async setEffort(effort: string): Promise<Result> {
    return this.setModel(this.info.model ?? "", effort);
  }

  async setMode(mode: Mode): Promise<Result> {
    if (!this.capabilities.modes.includes(mode))
      return { ok: false, error: `${this.info.poweredBy} has no ${mode} mode` };
    const result = await this.attempt((harness) => harness.setMode(mode));
    if (result.ok) {
      this.info = { ...this.info, mode };
      this.touch("info");
    }
    return result;
  }

  compact(): Promise<Result> {
    return this.attempt((harness) => harness.compact());
  }

  async newSession(): Promise<Result> {
    const result = await this.attempt(async (harness) => {
      if (this.state === "running") await harness.interrupt();
      await harness.newSession();
    });
    if (result.ok) {
      this.reset([]);
      this.plan = [];
      this.usage = {};
      this.queued = [];
      this.requests.clear();
      this.error = null;
      this.state = "idle";
      this.touch("plan", "usage", "queued", "requests", "error", "state");
    }
    return result;
  }

  resume(id: string): Promise<Result> {
    return this.attempt(async (harness) => {
      if (this.state === "running") await harness.interrupt();
      this.plan = [];
      this.requests.clear();
      this.touch("plan", "requests");
      await harness.resume(id);
    });
  }

  async listSessions(): Promise<
    { ok: true; sessions: readonly SessionSummary[] } | { ok: false; error: string }
  > {
    try {
      const harness = await this.ready();
      return {
        ok: true,
        sessions: await within(harness.listSessions(), LIST_TIMEOUT_MS, "Listing sessions"),
      };
    } catch (error: unknown) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /**
   * Updates for one subscriber: a snapshot at once, then what changed, at most once per
   * interval. A hand-written iterator rather than a generator: when the Client leaves,
   * Flight calls `return()`/`throw()` while the subscriber waits for a change that may
   * never come, and only an iterator can end that wait.
   */
  subscribe(): AsyncIterableIterator<Update> {
    let seen = -1;
    let seq = 0;
    let last = 0;
    let closed = false;
    let wake: (() => void) | null = null;
    const listener = () => wake?.();
    this.listeners.add(listener);
    const close = (): IteratorResult<Update> => {
      closed = true;
      this.listeners.delete(listener);
      wake?.();
      return { done: true, value: undefined };
    };
    const iterator: AsyncIterableIterator<Update> = {
      [Symbol.asyncIterator]: () => iterator,
      next: async () => {
        while (!closed && this.revision === seen)
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        const wait = last + UPDATE_INTERVAL_MS - Date.now();
        if (wait > 0) await Bun.sleep(wait);
        if (closed) return { done: true, value: undefined };
        const since = seen;
        seen = this.revision;
        last = Date.now();
        if (since < 0 || this.resetRevision > since)
          return {
            done: false,
            value: { kind: "snapshot", seq: seq++, snapshot: this.snapshot() },
          };
        const changed = (revision: number | undefined) => (revision ?? 0) > since;
        return {
          done: false,
          value: {
            kind: "patch",
            seq: seq++,
            items: this.order.flatMap((id) => {
              const item = this.byId.get(id);
              return item && changed(this.itemRevision.get(id)) ? [item] : [];
            }),
            removed: this.removals.filter((r) => r.revision > since).map((r) => r.id),
            fields: this.fields(
              [...this.fieldRevision]
                .filter(([, revision]) => changed(revision))
                .map(([key]) => key),
            ),
          },
        };
      },
      return: async () => close(),
      throw: async () => close(),
    };
    return iterator;
  }

  /** Stops the harness with the Server: a harness child never outlives it. */
  close() {
    void this.harness?.close();
  }

  harnessId(): HarnessId {
    return this.info.harness;
  }
}

export const session = new Session();
process.on("exit", () => session.close());
