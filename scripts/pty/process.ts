/** Subprocess ownership that survives the death of a journey, including SIGKILL. */
import { join } from "node:path";
import * as z from "zod/mini";

export function bounded<T>(work: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** The independent guard launches the child in its own process group. */
export async function managedProcess(
  command: readonly string[],
  options: { env?: Record<string, string>; directory?: string } = {},
) {
  let reportPid: (pid: number) => void = () => {};
  const ready = new Promise<number>((resolve) => {
    reportPid = resolve;
  });
  const guard = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "process-guard.ts"),
      JSON.stringify({ command, directory: options.directory }),
    ],
    {
      env: options.env,
      detached: true,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      ipc(message: unknown) {
        const ready = z.object({ pid: z.number() }).safeParse(message);
        if (ready.success) reportPid(ready.data.pid);
      },
    },
  );
  let pid: number;
  try {
    pid = await bounded(
      Promise.race([
        ready,
        guard.exited.then(() => {
          throw new Error(`${command[0]} did not start`);
        }),
      ]),
      10_000,
      `${command[0]} did not start`,
    );
  } catch (error) {
    await guard.stdin.end();
    throw error;
  }
  const stop = async () => {
    try {
      process.kill(-pid, "SIGTERM");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
    }
    // Keep graceful shutdown, but bound it before ending the lifetime lease.
    await bounded(guard.exited, 5000, "child did not stop").catch(async () => {
      await guard.stdin.end();
    });
    await guard.exited;
  };
  return { child: { pid, stdout: guard.stdout, stderr: guard.stderr, exited: guard.exited }, stop };
}
