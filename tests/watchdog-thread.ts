/**
 * The thread tests/watchdog.ts starts in every test file: it takes the main thread's
 * heartbeat, samples a silent worker before its deadline, then kills it at the same
 * deadline. Nothing here depends on the blocked main thread's event loop.
 */
import { writeSync } from "node:fs";
import { isMainThread, parentPort, workerData } from "node:worker_threads";

type Beat = { file?: string; phase?: string; test?: string; ordinal?: number; stop?: boolean };
type Capture = { output: string; stop: () => void; finished: boolean };

const STACK_BYTES = 32768;

/** Start early enough that sampling never postpones the worker's kill deadline. */
function sample(pid: string): Capture {
  const result: Capture = {
    output: "Native stack capture did not finish before the kill deadline.\n",
    stop: () => {},
    finished: true,
  };
  const tool =
    process.platform === "darwin"
      ? Bun.which("sample")
      : (Bun.which("gdb") ?? Bun.which("eu-stack"));
  if (!tool) {
    result.output =
      "Native stack unavailable: no sampling tool exists (sample on macOS; gdb or eu-stack on Linux).\n";
    return result;
  }
  const args =
    process.platform === "darwin"
      ? [tool, pid, "1", "-file", "/dev/stdout"]
      : tool.endsWith("/gdb")
        ? [tool, "-p", pid, "-batch", "-ex", "thread apply all bt"]
        : [tool, "-p", pid];
  try {
    const child = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    result.output = `Native stack capture (${tool}):\n`;
    result.finished = false;
    result.stop = () => {
      child.kill("SIGKILL");
    };
    let bytes = 0;
    const collect = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        const kept = chunk.subarray(0, Math.max(0, STACK_BYTES - bytes));
        bytes += kept.length;
        result.output += decoder.decode(kept, { stream: true });
        if (kept.length < chunk.length) {
          result.output += "\nNative stack truncated at 32768 bytes.\n";
          result.stop();
          break;
        }
      }
      result.output += decoder.decode();
    };
    void Promise.all([collect(child.stdout), collect(child.stderr), child.exited]).then(
      ([, , code]) => {
        result.finished = true;
        result.output += `\nSampling tool exited with code ${code}.\n`;
      },
      (error: unknown) => {
        result.finished = true;
        result.output += `\nNative stack capture failed: ${String(error)}\n`;
      },
    );
  } catch (error: unknown) {
    result.output = `Native stack capture could not start: ${String(error)}\n`;
  }
  return result;
}

type Report = { pid: number; deadline: number; header: string };

if (isMainThread) {
  // A debugger may suspend *every* thread in the worker. Its deadline and output
  // must therefore live in a separate process, not in the thread it samples.
  const raw: unknown = JSON.parse(process.argv[2] ?? "{}");
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("pid" in raw) ||
    typeof raw.pid !== "number" ||
    !("deadline" in raw) ||
    typeof raw.deadline !== "number" ||
    !("header" in raw) ||
    typeof raw.header !== "string"
  ) {
    throw new Error("Invalid watchdog report arguments");
  }
  const report: Report = { pid: raw.pid, deadline: raw.deadline, header: raw.header };
  let capture: Capture | undefined;
  setTimeout(
    () => {
      capture?.stop();
      const output =
        capture?.output ?? "Native stack capture could not start before the kill deadline.\n";
      writeSync(
        2,
        report.header +
          output +
          (capture?.finished ? "" : "\nNative stack capture stopped at the kill deadline.\n"),
      );
      try {
        process.kill(report.pid, "SIGKILL");
      } catch (error: unknown) {
        // Another failure may have already killed the worker during capture.
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "ESRCH"
        )
          throw error;
      }
      process.exit(0);
    },
    Math.max(0, report.deadline - Date.now()),
  );
  process.on("SIGTERM", () => {
    capture?.stop();
    process.exit(0);
  });
  capture = sample(String(report.pid));
} else {
  const blockedMs = Number(workerData);
  // sample spends a second collecting, then symbolizes the stack. Two seconds
  // was too short on CI. Leave several seconds even after the polling interval;
  // short diagnostic deadlines reserve the same proportion without moving them.
  const captureMs = Math.min(15_000, blockedMs * 0.8);
  let last = Date.now();
  let file = "?";
  let phase = "?";
  let test = "unavailable (no test name supplied)";
  let ordinal = 0;
  let reporter: Bun.Subprocess | undefined;
  let failure = "";
  parentPort?.on("message", (beat: Beat) => {
    last = Date.now();
    reporter?.kill("SIGTERM");
    reporter = undefined;
    failure = "";
    if (beat.stop) {
      parentPort?.postMessage("stopped");
      return;
    }
    if (beat.file === undefined) return;
    file = beat.file;
    phase = beat.phase ?? "?";
    ordinal = beat.ordinal ?? 0;
    test = beat.test ?? "unavailable (no test name supplied)";
  });
  setInterval(() => {
    const silent = Date.now() - last;
    if (silent < blockedMs - captureMs) return;
    const header = `\nluciole tests: the main thread of this worker has answered nothing for ${Math.round(blockedMs / 1000)} s in ${file} (${phase}), test start #${ordinal}, test: ${test}: a synchronous call that never returns. Killing the worker so the run fails now instead of hanging.\n`;
    if (!reporter && !failure) {
      try {
        const report: Report = { pid: process.pid, deadline: last + blockedMs, header };
        reporter = Bun.spawn([process.execPath, import.meta.filename, JSON.stringify(report)], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "inherit",
        });
      } catch (error: unknown) {
        failure = `Native stack reporter could not start: ${String(error)}\n`;
      }
    }
    if (silent < blockedMs || (reporter && reporter.exitCode === null)) return;
    writeSync(2, header + (failure || "Native stack reporter exited before reporting.\n"));
    process.kill(process.pid, "SIGKILL");
  }, blockedMs / 10);
}
