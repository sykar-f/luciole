import { expect, test } from "bun:test";
import { PIXEL_SCROLL_FLAG, splitArgs } from "../packages/core/src/launcher/app-args";

for (const role of [
  ["--url", "http://localhost"],
  ["serve", "--http", ":3000"],
]) {
  for (const enabled of [false, true]) {
    test(`binary pixel launch: ${role[0]}, flag ${enabled}`, async () => {
      const child = Bun.spawn(
        [
          process.execPath,
          "tests/binary-pixel-launch.ts",
          ...role,
          ...(enabled ? ["--pixel-scroll"] : []),
        ],
        {
          env: { ...process.env, LUCIOLE_PIXEL_SCROLL: undefined },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, stderr).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ pixelScroll: enabled ? "1" : null });
    });
  }
}

test("the runtime parser leaves pixel-scroll after -- to the application", () => {
  const after = splitArgs(["--", "--pixel-scroll"], [PIXEL_SCROLL_FLAG]);
  expect(after.flags.has("pixel-scroll")).toBe(false);
  expect(after.app).toEqual(["--pixel-scroll"]);
  const before = splitArgs(["--pixel-scroll", "--", "--pixel-scroll"], [PIXEL_SCROLL_FLAG]);
  expect(before.flags.has("pixel-scroll")).toBe(true);
  expect(before.app).toEqual(["--pixel-scroll"]);
});
