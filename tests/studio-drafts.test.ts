/** studio's drafts: writes grouped, one draft at a time, the latest wins, the turn's end cancels. */
import { expect, test } from "bun:test";
import { DraftScheduler, type Draft, type Timers } from "../examples/studio/server/drafts";

const DELAY_MS = 30;

/**
 * A clock the test moves: timers fire in their order when `advance` passes them, each
 * followed by the microtasks it queued (as is the advance itself, for what the test
 * resolved). No real time passes, whatever the machine's load.
 */
function clock() {
  let now = 0,
    next = 0;
  const timers = new Map<number, { at: number; fire: () => void }>();
  const settle = () => new Promise<void>((done) => setImmediate(done));
  return {
    timers: {
      setTimeout: (callback: () => void, ms: number) => {
        timers.set(++next, { at: now + ms, fire: callback });
        return next;
      },
      clearTimeout: (timer: number | Timer) => {
        if (typeof timer === "number") timers.delete(timer);
      },
    } satisfies Timers,
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers]
          .filter(([, timer]) => timer.at <= until)
          .sort(([, a], [, b]) => a.at - b.at);
        const first = due[0];
        if (!first) break;
        const [id, timer] = first;
        timers.delete(id);
        now = timer.at;
        timer.fire();
        await settle();
      }
      now = until;
      await settle();
    },
  };
}

/** A scheduler on the test's clock, whose drafts the test ends, each one when it says so. */
function scheduler() {
  const drafts: { draft: Draft; finish: () => void }[] = [];
  const time = clock();
  const drafting = new DraftScheduler({
    delayMs: DELAY_MS,
    timers: time.timers,
    run: (draft) =>
      new Promise<void>((finish) => {
        drafts.push({ draft, finish });
      }),
  });
  return { drafting, drafts, advance: (ms: number) => time.advance(ms) };
}

test("the writes of a moment make one draft", async () => {
  const { drafting, drafts, advance } = scheduler();
  drafting.written();
  await advance(DELAY_MS / 2);
  drafting.written();
  await advance(DELAY_MS / 2);
  drafting.written();
  await advance(DELAY_MS - 1);
  expect(drafts).toHaveLength(0);
  await advance(1);
  expect(drafts).toHaveLength(1);
  drafts[0]?.finish();
  await drafting.idle();
  expect(drafts).toHaveLength(1);
});

test("a newer write supersedes the running draft, and the next one waits for it", async () => {
  const { drafting, drafts, advance } = scheduler();
  drafting.written();
  await advance(DELAY_MS);
  const [first] = drafts;
  expect(first?.draft.superseded).toBe(false);
  drafting.written();
  drafting.written();
  await advance(DELAY_MS);
  // One draft at a time: the first is told to give up, the second has not started.
  expect(first?.draft.superseded).toBe(true);
  expect(drafts).toHaveLength(1);
  first?.finish();
  await advance(0);
  expect(drafts).toHaveLength(2);
  expect(drafts[1]?.draft.superseded).toBe(false);
  drafts[1]?.finish();
  await drafting.idle();
  expect(drafts).toHaveLength(2);
});

test("the end of the turn cancels the waiting draft and supersedes the running one", async () => {
  const { drafting, drafts, advance } = scheduler();
  drafting.written();
  await advance(DELAY_MS);
  drafting.written();
  drafting.cancel();
  expect(drafts[0]?.draft.superseded).toBe(true);
  drafts[0]?.finish();
  await advance(DELAY_MS * 2);
  await drafting.idle();
  expect(drafts).toHaveLength(1);
});

test("a draft that throws does not stop the next ones", async () => {
  let runs = 0;
  const time = clock();
  const drafting = new DraftScheduler({
    delayMs: DELAY_MS,
    timers: time.timers,
    run: async () => {
      runs++;
      throw new Error("the build failed");
    },
  });
  drafting.written();
  await time.advance(DELAY_MS);
  drafting.written();
  await time.advance(DELAY_MS);
  await drafting.idle();
  expect(runs).toBe(2);
});

test("idle waits for a draft still to come, and ends when the delay is cleared", async () => {
  const { drafting, drafts, advance } = scheduler();
  drafting.written();
  let idle = false;
  const waiting = drafting.idle().then(() => (idle = true));
  await advance(DELAY_MS - 1);
  expect(idle).toBe(false);
  drafting.cancel();
  await waiting;
  expect(drafts).toHaveLength(0);
});
