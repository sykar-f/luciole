/** Keep the CDP server outside Bun's parallel test worker. */
import { expect, test } from "bun:test";

const TIMEOUT_MS = 20_000;
for (const dpr of [1, 2]) {
  test(
    `pixel host presents atomic, clipped GPU frames at DPR ${dpr}`,
    async () => {
      const child = Bun.spawn(
        [process.execPath, import.meta.dir + "/pixel-scroll.ts", String(dpr)],
        {
          stdout: "inherit",
          stderr: "inherit",
        },
      );
      try {
        const code = await child.exited;
        if (code !== 0) throw new Error(`pixel probe exited ${code}`);
        expect(code).toBe(0);
      } finally {
        child.kill();
      }
    },
    TIMEOUT_MS,
  );
}
