/**
 * The thread tests/watchdog.ts starts in every test file: it takes the main thread's
 * heartbeat and kills the worker when the heartbeat stops for `workerData` milliseconds.
 * Plain code with nothing of the main thread's state, so it keeps running while that
 * thread is blocked.
 */
import { writeSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

type Beat = { file?: string; phase?: string };

const blockedMs = Number(workerData);
let last = Date.now();
let file = "?";
let phase = "?";
parentPort?.on("message", (beat: Beat) => {
  last = Date.now();
  if (beat.file === undefined) return;
  file = beat.file;
  phase = beat.phase ?? "?";
});
setInterval(() => {
  const silent = Date.now() - last;
  if (silent < blockedMs) return;
  writeSync(
    2,
    `\nluciole tests: the main thread of this worker has answered nothing for ${Math.round(silent / 1000)} s in ${file} (${phase}): a synchronous call that never returns. Killing the worker so the run fails now instead of hanging.\n`,
  );
  process.kill(process.pid, "SIGKILL");
}, blockedMs / 10);
