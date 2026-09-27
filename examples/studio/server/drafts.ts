/**
 * When studio builds a draft of the app while the harness writes it (docs/studio/SPEC.md,
 * 3.3): the writes of a moment make one draft, one draft runs at a time, and a newer write
 * supersedes the draft that runs, which stops at its next step and gives way to a new one.
 * The end of the turn cancels them: the revision takes over.
 */

/** One draft: it checks `superseded` between its steps and drops its work when set. */
export type Draft = { readonly id: number; readonly superseded: boolean };

type Running = { id: number; superseded: boolean };

export class DraftScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Running | undefined;
  private done: Promise<void> = Promise.resolve();
  /** A write came while a draft ran: another one starts when it ends. */
  private again = false;
  private next = 0;
  private readonly delayMs: number;
  private readonly run: (draft: Draft) => Promise<void>;

  constructor(options: { delayMs: number; run: (draft: Draft) => Promise<void> }) {
    this.delayMs = options.delayMs;
    this.run = options.run;
  }

  /** The harness wrote files: a draft once no other write came for the delay. */
  written() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.running) return this.start();
      this.running.superseded = true;
      this.again = true;
    }, this.delayMs);
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
    clearTimeout(this.timer);
    this.timer = undefined;
    this.again = false;
    if (this.running) this.running.superseded = true;
  }

  /** Resolves once no draft waits or runs. */
  async idle() {
    while (this.running || this.timer) {
      await this.done;
      if (this.timer) await Bun.sleep(this.delayMs);
    }
  }
}
