import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { createInterface } from "node:readline";
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
  const child = spawn(process.execPath, ["--conditions=react-server", file], {
    env: { ...process.env, PORT: "0", LUCIOLE_TEST: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (s: Buffer) => (errors += s.toString()));
  const ready = await new Promise<z.infer<typeof Ready>>((yes, no) => {
    const timer = setTimeout(() => {
      child.kill();
      no(new Error("startup timeout " + errors));
    }, STARTUP_TIMEOUT_MS);
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
