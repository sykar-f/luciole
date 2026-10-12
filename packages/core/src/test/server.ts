import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const STARTUP_TIMEOUT_MS = 10_000;
/** The line a Server prints once it listens (src/server.ts). */
const Ready = z.object({
  ready: z.literal(true),
  port: z.number().int(),
  pid: z.number().int(),
  buildId: z.string(),
});

/** A Server running in a process of its own, as `startServer` returns it. */
export type TestServer = {
  /** The Server's process. */
  child: ChildProcessByStdio<null, Readable, Readable>;
  /** The port it listens on, chosen by the system. */
  port: number;
  /** The process id. */
  pid: number;
  /** The id of the build it serves. */
  buildId: string;
  /** Where it listens: `http://127.0.0.1:<port>`. */
  url: string;
  /** Stops the process and resolves once it has exited. Stopping twice is harmless. */
  stop(): Promise<void>;
  /** Same as `stop()`, for `await using`. */
  [Symbol.asyncDispose](): Promise<void>;
};

/**
 * Starts the Server bundle at `file` on a free port and resolves once it says it listens.
 * `LUCIOLE_TEST=1` turns on the Server's test mode (`/test-metrics`).
 */
export async function launchServer(
  file: string,
  env: Record<string, string> = {},
): Promise<TestServer> {
  const directory = await mkdtemp(join(tmpdir(), "luciole-startup-"));
  try {
    return await launchTraced(
      file,
      env,
      join(directory, "stages.jsonl"),
      join(directory, "preload.js"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function launchTraced(
  file: string,
  env: Record<string, string>,
  trace: string,
  preload: string,
): Promise<TestServer> {
  // A mark before the bundle loads distinguishes runtime/module loading from app startup.
  await writeFile(
    preload,
    `import {appendFileSync} from "node:fs";
try { appendFileSync(process.env.LUCIOLE_TEST_STARTUP_TRACE, JSON.stringify({stage:"process-entry",at:Date.now(),cpu:process.cpuUsage()})+"\\n"); } catch {}`,
  );
  const started = performance.now();
  const child = spawn(process.execPath, ["--conditions=react-server", "--preload", preload, file], {
    env: {
      ...process.env,
      PORT: "0",
      LUCIOLE_TEST: "1",
      ...env,
      LUCIOLE_TEST_STARTUP_TRACE: trace,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (s: Buffer) => (errors += s.toString()));
  const chunks: Buffer[] = [];
  const received = (chunk: Buffer) => chunks.push(chunk);
  child.stdout.on("data", received);
  let ready: z.infer<typeof Ready>;
  try {
    ready = await new Promise<z.infer<typeof Ready>>((yes, no) => {
      const timer = setTimeout(() => {
        const output = Buffer.concat(chunks)
          .toString("utf8")
          .split(/\r\n|\r|\n/);
        let stages = "";
        try {
          stages = readFileSync(trace, "utf8").trimEnd();
        } catch {
          // No mark means the child did not reach even its preload, or could not write it.
        }
        const state = {
          pid: child.pid ?? null,
          alive: child.exitCode === null && child.signalCode === null,
          exitCode: child.exitCode,
          signal: child.signalCode,
        };
        const lastStage = stages.split("\n").at(-1) || "none received";
        let interval = "";
        try {
          const mark = z.object({ stage: z.string() }).safeParse(JSON.parse(lastStage));
          if (mark.success && mark.data.stage === "core-module-load")
            interval =
              "\npending startup interval: application module loading (after core-module-load, before serve-entry)";
        } catch {
          // Keep the raw last mark in the report even if a trace write was incomplete.
        }
        const report = `startup timeout after ${Math.round(performance.now() - started)} ms
child: ${JSON.stringify(state)}
stdout: ${JSON.stringify({ lines: output.slice(0, -1), partial: output.at(-1) ?? "" })}
last startup stage: ${lastStage}${interval}
startup stages:\n${stages || "none received"}
stderr: ${errors}`;
        child.kill();
        no(new Error(report));
      }, STARTUP_TIMEOUT_MS);
      child.once("error", (error) => {
        clearTimeout(timer);
        no(error);
      });
      child.on("exit", () => {
        clearTimeout(timer);
        no(new Error("server exited " + errors));
      });
      createInterface({ input: child.stdout }).on("line", (line) => {
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          return;
        }
        const parsed = Ready.safeParse(value);
        if (!parsed.success) return;
        clearTimeout(timer);
        yes(parsed.data);
      });
    });
  } finally {
    child.stdout.off("data", received);
  }
  const stop = () =>
    new Promise<void>((done) => {
      if (child.exitCode !== null || child.signalCode !== null) return done();
      child.once("exit", () => done());
      child.kill();
    });
  return {
    child,
    ...ready,
    url: `http://127.0.0.1:${ready.port}`,
    stop,
    [Symbol.asyncDispose]: stop,
  };
}

/**
 * Starts the Server of a built app, as `luciole start` would, on a free port. `env` adds
 * to the process environment, such as the app's own settings (a database path). Network
 * conditions are the Client's: pass `latencyMs` and `network` to `openClient`. Stop it with
 * `await using` or `stop()`.
 */
export function startServer(app: { output: string }, env: Record<string, string> = {}) {
  return launchServer(join(app.output, "server/index.js"), env);
}
