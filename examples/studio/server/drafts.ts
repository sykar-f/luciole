/**
 * When studio builds a draft of the app while the harness writes it (docs/studio/SPEC.md,
 * 3.3): the writes of a moment make one draft, one draft runs at a time, and a newer write
 * supersedes the draft that runs, which stops at its next step and gives way to a new one.
 * The end of the turn cancels them: the revision takes over.
 */

/** One draft: it checks `superseded` between its steps and drops its work when set. */
export type Draft = { readonly id: number; readonly superseded: boolean };

type Running = { id: number; superseded: boolean };

/**
 * The timers the scheduler waits with: the platform's, or a test's clock that advances
 * on demand (a scheduler on sleeps would make its tests depend on the machine's load).
 */
export type Timers = {
  setTimeout(callback: () => void, ms: number): number | Timer;
  clearTimeout(timer: number | Timer): void;
};
const platformTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer),
};

/** The delay before a draft, with what `idle` waits on: the moment it fires or is cleared. */
type Pending = { timer: number | Timer; over: Promise<void>; end: () => void };

export class DraftScheduler {
  private pending: Pending | undefined;
  private running: Running | undefined;
  private done: Promise<void> = Promise.resolve();
  /** A write came while a draft ran: another one starts when it ends. */
  private again = false;
  private next = 0;
  private readonly delayMs: number;
  private readonly run: (draft: Draft) => Promise<void>;
  private readonly timers: Timers;

  constructor(options: { delayMs: number; run: (draft: Draft) => Promise<void>; timers?: Timers }) {
    this.delayMs = options.delayMs;
    this.run = options.run;
    this.timers = options.timers ?? platformTimers;
  }

  /** The harness wrote files: a draft once no other write came for the delay. */
  written() {
    this.disarm();
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = this.timers.setTimeout(() => {
      this.pending = undefined;
      resolve();
      if (!this.running) return this.start();
      this.running.superseded = true;
      this.again = true;
    }, this.delayMs);
    this.pending = { timer, over: promise, end: resolve };
  }

  private disarm() {
    if (!this.pending) return;
    this.timers.clearTimeout(this.pending.timer);
    this.pending.end();
    this.pending = undefined;
  }

  private start() {
    const draft: Running = { id: ++this.next, superseded: false };
    this.running = draft;
    this.done = this.run(draft)
      .catch(() => {})
      .finally(() => {
        this.running = undefined;
        if (!this.again) return;
        this.again = false;
        this.start();
      });
  }

  /** No draft from now on: the one waiting is dropped, the one running superseded. */
  cancel() {
    this.disarm();
    this.again = false;
    if (this.running) this.running.superseded = true;
  }

  /** Resolves once no draft waits or runs. */
  async idle() {
    while (this.running || this.pending) {
      if (this.pending) await this.pending.over;
      await this.done;
    }
  }
}
