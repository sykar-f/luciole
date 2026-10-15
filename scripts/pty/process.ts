/** Subprocess ownership that survives the death of a journey, including SIGKILL. */
import { join } from "node:path";

export function bounded<T>(work: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** `detached` gives descendants a private group; the guard outlives the owner. */
export function managedProcess(
  command: readonly string[],
  options: { env?: Record<string, string>; directory?: string } = {},
) {
  const child = Bun.spawn([...command], {
    env: options.env,
    detached: true,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const kill = (signal: NodeJS.Signals) => {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
    }
  };
  let guard;
  try {
    guard = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "process-guard.ts"),
        String(child.pid),
        options.directory ?? "",
      ],
      { detached: true, stdin: "pipe", stdout: "ignore", stderr: "inherit" },
    );
  } catch (error) {
    kill("SIGKILL");
    throw error;
  }
  const stop = async () => {
    kill("SIGTERM");
    const grace = 5000;
    await bounded(child.exited, grace, "child did not stop").catch(() => kill("SIGKILL"));
    // The guard kills descendants even if the group leader already exited.
    await guard.stdin.end();
    await guard.exited;
    await child.exited;
  };
  return { child, stop };
}
