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
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (code !== 0) throw new Error(out + err);
      expect(code).toBe(0);
    },
    TIMEOUT_MS,
  );
}
