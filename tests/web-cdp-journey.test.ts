/** Selected browser journey: run explicitly, with an installed Chrome. */
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test.skipIf(!existsSync(chrome))(
  "the existing Coder browser journey passes",
  async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../scripts/web/coder.ts")], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 90_000,
      killSignal: "SIGKILL",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ exit, stderr: exit ? stderr : "", stdout: exit ? stdout : "" }).toEqual({
      exit: 0,
      stderr: "",
      stdout: "",
    });
  },
  100_000,
);
