/** Subprocess ownership that survives the death of a journey, including SIGKILL. */
import { join } from "node:path";
import * as z from "zod/mini";
import { signalGroup } from "./process-group";

export function bounded<T>(work: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

const Cleanup = z.object({ ok: z.boolean(), error: z.optional(z.string()) });

/** The independent guard launches the child in its own process group. */
export async function managedProcess(
  command: readonly string[],
  options: { env?: Record<string, string>; directory?: string } = {},
) {
  let cleanup: z.infer<typeof Cleanup> | undefined;
  let channelClosed: () => void = () => {};
  const disconnected = new Promise<void>((resolve) => {
    channelClosed = resolve;
  });
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
      onDisconnect() {
        channelClosed();
      },
      ipc(message: unknown, subprocess) {
        const ready = z.object({ pid: z.number() }).safeParse(message);
        if (ready.success) reportPid(ready.data.pid);
        const result = z.object({ cleanup: Cleanup }).safeParse(message);
        if (result.success) {
          cleanup = result.data.cleanup;
          subprocess.send({ cleanupReceived: true });
        }
      },
    },
  );
  const [stderr, capturedStderr] = guard.stderr.tee();
  const errors = new Response(capturedStderr).text().catch(String);
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
    signalGroup(pid, "SIGTERM");
    // Keep graceful shutdown, but bound it before ending the lifetime lease.
    await bounded(guard.exited, 5000, "child did not stop").catch(async () => {
      await guard.stdin.end();
    });
    const [exitCode] = await Promise.all([guard.exited, disconnected]);
    if (!cleanup?.ok)
      throw new Error(
        `guard ${guard.pid} exited ${exitCode}: ${cleanup?.error ?? "no cleanup result"}\n${await errors}`,
      );
  };
  return { child: { pid, stdout: guard.stdout, stderr, exited: guard.exited }, stop };
}
