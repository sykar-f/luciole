/** An independent owner: EOF also arrives when the journey is killed with SIGKILL. */
import { rmSync } from "node:fs";

const pid = Number(process.argv[2]);
const directory = process.argv[3];
for await (const _chunk of Bun.stdin.stream()) {
  // The pipe is a lifetime lease, not a command channel.
}
try {
  process.kill(-pid, "SIGKILL");
} catch (error) {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
}
if (directory) rmSync(directory, { recursive: true, force: true });
