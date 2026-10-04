/**
 * What the PTY journeys share around the driver: the repository's paths, private
 * temporary directories, built example Servers on a free port, the `luciole` CLI, and the
 * JSON report each journey prints. Every resource is `await using`-disposable, so that a
 * failed assertion still stops the processes it started.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

export const ROOT = resolve(import.meta.dir, "../..");
/** The Bun running this journey: the one every program under test runs on too. */
export const BUN = process.execPath;
export const CLI = join(ROOT, "packages/core/src/cli.ts");
export const example = (name: string) => join(ROOT, "examples", name);
/**
 * How long a wait lasts unless told otherwise: the guard against a hang, which says nothing
 * of how fast the program should be. The driver's own HANG_MS (driver.ts).
 */
export const HANG_MS = 30_000;
const STOP_TIMEOUT_MS = 5000;

/** A fresh directory, removed with its content at the end of the scope. */
export function temporaryDirectory(prefix: string, parent = tmpdir()) {
  const path = mkdtempSync(join(parent, prefix));
  return {
    path,
    [Symbol.dispose]: () => rmSync(path, { recursive: true, force: true }),
  };
}

/** `process.env` with `env` on top; `undefined` removes a variable. */
export function environment(env: Record<string, string | undefined> = {}) {
  const merged: Record<string, string> = {};
  for (const [name, value] of Object.entries({ ...process.env, ...env }))
    if (value !== undefined) merged[name] = value;
  return merged;
}

const Ready = z.object({ port: z.number().int() }).loose();
/**
 * A process that prints a JSON line with its port when it listens (a luciole Server, a
 * fake upstream). Stopped with SIGTERM at the end of the scope.
 */
export async function listening(
  command: readonly string[],
  env: Record<string, string | undefined>,
) {
  const child = Bun.spawn([...command], { env: environment(env), stdout: "pipe", stderr: "pipe" });
  const errors = new Response(child.stderr).text();
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    if (!(await Promise.race([child.exited.then(() => true), Bun.sleep(STOP_TIMEOUT_MS)])))
      child.kill("SIGKILL");
    await child.exited;
  };
  let port: number;
  try {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let line = "";
    while (!line.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`${command.join(" ")} did not start:\n${await errors}`);
      line += decoder.decode(chunk.value, { stream: true });
    }
    reader.releaseLock();
    ({ port } = Ready.parse(JSON.parse(line.slice(0, line.indexOf("\n")))));
  } catch (error: unknown) {
    await stop();
    throw error;
  }
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    pid: child.pid,
    stop,
    [Symbol.asyncDispose]: stop,
  };
}

/** The built Server of an application (`luciole build`), in production. */
export const startServer = (app: string, env: Record<string, string | undefined> = {}) =>
  listening([BUN, "--conditions=react-server", join(app, ".luciole/server/index.js")], {
    NODE_ENV: "production",
    PORT: "0",
    ...env,
  });

/** Runs the `luciole` CLI to completion; `check` fails on a non-zero exit. */
export function luciole(
  args: readonly string[],
  options: { env?: Record<string, string | undefined>; cwd?: string; check?: boolean } = {},
) {
  const result = Bun.spawnSync([BUN, CLI, ...args], {
    env: environment(options.env),
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const outcome = {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
  if (options.check && outcome.exitCode !== 0)
    throw new Error(
      `luciole ${args.join(" ")} exited with ${outcome.exitCode}:\n${outcome.stderr}`,
    );
  return outcome;
}

/** `luciole build --app <app>`: the production artefacts a journey runs. */
export const build = (app: string, args: readonly string[] = [], env?: Record<string, string>) =>
  luciole(["build", "--app", app, ...args], { env, check: true });

/** What a command printed, or "" when it failed. */
export function commandOutput(command: readonly string[]) {
  const result = Bun.spawnSync([...command], { stdout: "pipe", stderr: "ignore" });
  return result.exitCode === 0 ? result.stdout.toString() : "";
}

/**
 * The processes among `pids` working in `directory`: a journey's own, told apart from
 * the same program the user runs elsewhere (a test's directory is private and unique).
 */
export function workingIn(pids: readonly string[], directory: string) {
  const real = `n${realpathSync(directory)}`;
  return pids.filter((pid) =>
    commandOutput(["lsof", "-a", "-p", pid, "-d", "cwd", "-Fn"]).split("\n").includes(real),
  );
}

/** Whether a process with this pid exists. */
export function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls `check` until it holds or `timeout` ms passed; whether it held. */
export async function eventually(
  check: () => boolean | Promise<boolean>,
  timeout: number = HANG_MS,
) {
  const POLL_MS = 100;
  const deadline = performance.now() + timeout;
  for (;;) {
    if (await check()) return true;
    if (performance.now() > deadline) return false;
    await Bun.sleep(POLL_MS);
  }
}

/** Runs `cleanup` at the end of the scope, as a `finally` block would. */
export const defer = (cleanup: () => void | Promise<void>): AsyncDisposable => ({
  [Symbol.asyncDispose]: async () => cleanup(),
});

/** A variable of the journey's environment as a number of milliseconds. */
export const numberFromEnv = (name: string, fallback: number) =>
  z.coerce
    .number()
    .int()
    .min(0)
    .parse(process.env[name] ?? fallback);

/** What a journey verified and measured, as JSON on stdout (docs/VALIDATION.md quotes it). */
export function report(results: Record<string, unknown>) {
  console.log(JSON.stringify(results, null, 2));
}
