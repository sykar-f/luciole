import { afterEach } from "bun:test";
import { act } from "react";
import type { Renderable } from "@opentui/core";
import type { testRender } from "@opentui/react/test-utils";
import { messageOf } from "../guards";

/**
 * The budget, in milliseconds, of a test that starts a Server and drives its Client. Pass it
 * as the last argument of `test()`: bun's default of 5 s leaves no room for a loaded
 * machine.
 */
export const TEST_TIMEOUT_MS = 60_000;

/**
 * How long a wait lasts before it gives up, in milliseconds: the guard against a hang, which
 * says nothing of how fast the event should come. A loaded machine only makes the wait
 * longer. Half of `TEST_TIMEOUT_MS`, so a wait that fails reports itself before bun ends the
 * test.
 */
export const WAIT_MS = TEST_TIMEOUT_MS / 2;

/** The pause between two polls of a wait. */
const POLL_MS = 10;

/** What `testRender` resolves with: the renderer, input mocks and frame captures. */
export type TestUI = Awaited<ReturnType<typeof testRender>>;

/** `headline`, then the state when there is one; a state that throws says so after it. */
function described(headline: string, state?: () => string) {
  if (!state) return headline;
  try {
    return `${headline}. State:\n${state()}`;
  } catch (error: unknown) {
    return `${headline}. State unavailable: ${messageOf(error)}`;
  }
}
const timedOut = (state?: () => string) => described("Condition timed out", state);

/**
 * The waits still polling. bun's timeout for a test that sets none ends it before `WAIT_MS`
 * ends its wait, and reports it without what the wait would have said. After each test, a
 * wait still polling prints its state under that test, then stops where it stands: the
 * abandoned test runs no further.
 */
type Wait = { start: number; state?: () => string; ended: boolean };
const waiting = new Set<Wait>();
try {
  afterEach(() => {
    for (const wait of waiting) {
      wait.ended = true;
      const ms = Math.round(performance.now() - wait.start);
      console.error(
        described(`The test ended while a wait still polled, after ${ms} ms`, wait.state),
      );
    }
    waiting.clear();
  });
} catch {
  // Outside bun test (a script importing a helper): no test ends a wait.
}
function watched(state?: () => string): Wait {
  const wait = { start: performance.now(), state, ended: false };
  waiting.add(wait);
  return wait;
}
/** Never settles: what an abandoned test would run after its wait never runs. */
const abandoned = () => new Promise<never>(() => {});

/**
 * Polls `check` until it holds. On a timeout it fails with "Condition timed out" and, when
 * given, what `state()` returns: what the process and its screen showed. `timeout` is the
 * guard against a hang, in milliseconds. Default: `WAIT_MS`.
 */
export async function until(check: () => boolean, timeout = WAIT_MS, state?: () => string) {
  const wait = watched(state);
  try {
    while (!check()) {
      if (wait.ended) return abandoned();
      if (performance.now() - wait.start > timeout) throw new Error(timedOut(state));
      await Bun.sleep(POLL_MS);
    }
  } finally {
    waiting.delete(wait);
  }
}

/**
 * `until` for a check that must ask: a socket, a file, another process. `timeout` is the
 * guard against a hang, in milliseconds. Default: `WAIT_MS`.
 */
export async function eventually(
  check: () => Promise<boolean>,
  timeout = WAIT_MS,
  state?: () => string,
) {
  const wait = watched(state);
  try {
    while (!(await check())) {
      if (wait.ended) return abandoned();
      if (performance.now() - wait.start > timeout) throw new Error(timedOut(state));
      await Bun.sleep(POLL_MS);
    }
  } finally {
    waiting.delete(wait);
  }
}

/**
 * Renders `ui` until its frame shows `text`, and returns that frame. A frame that never
 * shows it fails after `timeout` milliseconds (default: `WAIT_MS`) with the last frame.
 */
export async function untilFrame(ui: TestUI, text: string, timeout = WAIT_MS) {
  let frame = "";
  const wait = watched(() => frame);
  try {
    for (;;) {
      if (wait.ended) return abandoned();
      await act(async () => {
        await ui.renderOnce();
      });
      frame = ui.captureCharFrame();
      if (frame.includes(text)) return frame;
      if (performance.now() - wait.start > timeout) throw new Error(timedOut(() => frame));
      await Bun.sleep(POLL_MS);
    }
  } finally {
    waiting.delete(wait);
  }
}

/** What `node` and its descendants are still answering: a Tree-sitter highlight, an image. */
function answering(node: Renderable): Promise<unknown>[] {
  const own = [
    Reflect.get(node, "isHighlighting") === true && Reflect.get(node, "highlightingDone"),
    Reflect.get(node, "loading") === true && Reflect.get(node, "loadPromise"),
  ].filter((promise): promise is Promise<unknown> => promise instanceof Promise);
  return [...own, ...node.getChildren().flatMap(answering)];
}

/**
 * Renders `ui` until it shows `text`, nothing in it is still answering (a code block's
 * highlight, an image's load) and one more frame draws the same, then returns that frame.
 * It waits on those answers, not on time; `WAIT_MS` only guards against a hang.
 */
export async function untilDrawn(ui: TestUI, text = "") {
  let frame = "";
  let pending: Promise<unknown>[] = [];
  const wait = watched(() => `${pending.length} still answering, frame:\n${frame}`);
  const deadline = wait.start + WAIT_MS;
  let drawn: string | undefined;
  try {
    for (;;) {
      if (wait.ended) return abandoned();
      await act(async () => {
        await ui.renderOnce();
      });
      pending = answering(ui.renderer.root);
      frame = ui.captureCharFrame();
      if (!pending.length && frame === drawn) return frame;
      drawn = pending.length || !frame.includes(text) ? undefined : frame;
      const left = deadline - performance.now();
      if (left < 0) throw new Error(timedOut(() => frame));
      if (!pending.length) {
        // A turn of the event loop, not a delay: what is due (a timer, I/O) runs first.
        await act(() => new Promise<void>((done) => setImmediate(done)));
        continue;
      }
      // The hang guard, not a wait: it only ends the wait when an answer never comes.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const hang = new Promise<void>((done) => (timer = setTimeout(done, left)));
      await act(() => Promise.race([Promise.allSettled(pending), hang]));
      clearTimeout(timer);
    }
  } finally {
    waiting.delete(wait);
  }
}
