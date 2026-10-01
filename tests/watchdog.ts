/**
 * Fails a test worker whose main thread stops answering, instead of letting it hang the
 * run. bun test's per-test timeout runs on the thread it watches: a synchronous call
 * that never returns (Bun 1.4's spawnSync losing its child's exit, oven-sh/bun#34069)
 * blocks the timeout with the test, and `bun test --parallel` then waits forever. A
 * thread of its own takes the main thread's heartbeat; silence for BLOCKED_MS names the
 * file and kills the worker, which the run reports as a failure within seconds.
 * Loaded by bunfig.toml's [test] preload for every test file.
 */
import { afterAll, beforeAll, beforeEach } from "bun:test";
import { Worker } from "node:worker_threads";

const BEAT_MS = 500;
const BLOCKED_MS = Number(process.env.LUCIOLE_TEST_BLOCKED_MS) || 90_000;

// The watching thread: plain JavaScript, with nothing of the main thread's state.
const WATCHER = `
const { parentPort, workerData } = require("node:worker_threads");
const { writeSync } = require("node:fs");
let last = Date.now(), file = "?", phase = "?";
parentPort.on("message", (m) => { last = Date.now(); if (m.file) { file = m.file; phase = m.phase; } });
setInterval(() => {
  const silent = Date.now() - last;
  if (silent < workerData.blockedMs) return;
  writeSync(
    2,
    "\\nluciole tests: the main thread of this worker has answered nothing for " +
    Math.round(silent / 1000) + " s in " + file + " (" + phase + "): a synchronous call " +
    "that never returns. Killing the worker so the run fails now instead of hanging.\\n",
  );
  process.kill(process.pid, "SIGKILL");
}, workerData.blockedMs / 10);
`;
const watcher = new Worker(WATCHER, { eval: true, workerData: { blockedMs: BLOCKED_MS } });
watcher.unref();
const beat = setInterval(() => watcher.postMessage({}), BEAT_MS);
beat.unref();
const at = (phase: string) => () => watcher.postMessage({ file: Bun.main, phase });
beforeAll(at("beforeAll"));
beforeEach(at("test"));
afterAll(at("afterAll"));
