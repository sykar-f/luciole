/** studio's drafts: writes grouped, one draft at a time, the latest wins, the turn's end cancels. */
import { expect, test } from "bun:test";
import { DraftScheduler, type Draft } from "../examples/studio/server/drafts";

const DELAY_MS = 30;

/** A scheduler whose drafts the test ends, each one when it says so. */
function scheduler() {
  const drafts: { draft: Draft; finish: () => void }[] = [];
  const drafting = new DraftScheduler({
    delayMs: DELAY_MS,
    run: (draft) =>
      new Promise<void>((finish) => {
        drafts.push({ draft, finish });
      }),
  });
  return { drafting, drafts };
}

test("the writes of a moment make one draft", async () => {
  const { drafting, drafts } = scheduler();
  drafting.written();
  await Bun.sleep(DELAY_MS / 2);
  drafting.written();
  await Bun.sleep(DELAY_MS / 2);
  drafting.written();
  expect(drafts).toHaveLength(0);
  await Bun.sleep(DELAY_MS * 2);
  expect(drafts).toHaveLength(1);
  drafts[0]?.finish();
  await drafting.idle();
  expect(drafts).toHaveLength(1);
});

test("a newer write supersedes the running draft, and the next one waits for it", async () => {
  const { drafting, drafts } = scheduler();
  drafting.written();
  await Bun.sleep(DELAY_MS * 2);
  const [first] = drafts;
  expect(first?.draft.superseded).toBe(false);
  drafting.written();
  drafting.written();
  await Bun.sleep(DELAY_MS * 2);
  // One draft at a time: the first is told to give up, the second has not started.
  expect(first?.draft.superseded).toBe(true);
  expect(drafts).toHaveLength(1);
  first?.finish();
  await Bun.sleep(DELAY_MS);
  expect(drafts).toHaveLength(2);
  expect(drafts[1]?.draft.superseded).toBe(false);
  drafts[1]?.finish();
  await drafting.idle();
  expect(drafts).toHaveLength(2);
});

test("the end of the turn cancels the waiting draft and supersedes the running one", async () => {
  const { drafting, drafts } = scheduler();
  drafting.written();
  await Bun.sleep(DELAY_MS * 2);
  drafting.written();
  drafting.cancel();
  expect(drafts[0]?.draft.superseded).toBe(true);
  drafts[0]?.finish();
  await Bun.sleep(DELAY_MS * 2);
  await drafting.idle();
  expect(drafts).toHaveLength(1);
});

test("a draft that throws does not stop the next ones", async () => {
  let runs = 0;
  const drafting = new DraftScheduler({
    delayMs: DELAY_MS,
    run: async () => {
      runs++;
      throw new Error("the build failed");
    },
  });
  drafting.written();
  await Bun.sleep(DELAY_MS * 2);
  drafting.written();
  await Bun.sleep(DELAY_MS * 2);
  await drafting.idle();
  expect(runs).toBe(2);
});
