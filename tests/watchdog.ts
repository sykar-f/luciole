/**
 * Fails a test worker whose main thread stops answering, instead of letting it hang the
 * run. bun test's per-test timeout runs on the thread it watches: a synchronous call
 * that never returns (Bun 1.4's spawnSync losing its child's exit, oven-sh/bun#34069)
 * blocks the timeout with the test, and `bun test --parallel` then waits forever. A
 * thread of its own (tests/watchdog-thread.ts) takes the main thread's heartbeat; silence
 * for BLOCKED_MS names the file and kills the worker, which the run reports as a failure
 * within seconds. Loaded by bunfig.toml's [test] preload for every test file.
 */
import { afterAll, beforeAll, beforeEach } from "bun:test";
import { Worker } from "node:worker_threads";

const BEAT_MS = 500;
const BLOCKED_MS = Number(process.env.LUCIOLE_TEST_BLOCKED_MS) || 90_000;

// From a file, not `eval`: an eval'd Worker holds a blob: URL that Bun 1.4.2 revokes when
// the thread closes, and with `--isolate` a close after the file is a close on its retired
// global, where that revoke read a freed string and crashed the worker with SIGSEGV.
const watcher = new Worker(`${import.meta.dir}/watchdog-thread.ts`, { workerData: BLOCKED_MS });
watcher.unref();
const beat = setInterval(() => watcher.postMessage({}), BEAT_MS);
beat.unref();
const at = (phase: string) => () => watcher.postMessage({ file: Bun.main, phase });
beforeAll(at("beforeAll"));
beforeEach(at("test"));
// The preload's afterAll runs after the file's own: the thread watches the file to its
// end, then closes while the file's global is live. Left to `--isolate`, it was stopped
// with the file and closed during the next one, running code of a retired global.
afterAll(async () => {
  clearInterval(beat);
  await watcher.terminate();
});
