/** Owns the child before reporting it: no launch window can orphan a process. */
import { rmSync } from "node:fs";
import * as z from "zod/mini";

const config = z
  .object({ command: z.array(z.string()), directory: z.optional(z.string()) })
  .parse(JSON.parse(process.argv[2] ?? ""));
function killGroup(pid: number) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
  }
}
let child: Bun.Subprocess | undefined;
try {
  child = Bun.spawn(config.command, {
    detached: true,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.send?.({ pid: child.pid });
  const ownerGone = (async () => {
    for await (const _chunk of Bun.stdin.stream()) {
      // EOF is the lifetime lease ending, including an owner's SIGKILL.
    }
  })();
  await Promise.race([ownerGone, child.exited]);
} finally {
  if (child) {
    killGroup(child.pid);
    await child.exited;
  }
  if (config.directory) rmSync(config.directory, { recursive: true, force: true });
}
process.exit(child.exitCode ?? 1);
