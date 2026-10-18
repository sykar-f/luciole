/** Selected native proof for the two patches used by the web runtime. */
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const TIMEOUT_MS = 240_000;
const root = resolve(import.meta.dir, "../..");
test(
  "OpenTUI pixel patch: generated ABI and native tests",
  async () => {
    const checkout = join(
      mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "pixel-native-")),
      "opentui",
    );
    const zig = process.env["ZIG"] ?? "zig";
    const run = async (command: string[], cwd = checkout) => {
      const child = Bun.spawn(command, {
        cwd,
        env: { ...process.env, PATH: `${dirname(zig)}:${process.env["PATH"] ?? ""}` },
        stdout: "inherit",
        stderr: "inherit",
      });
      expect(await child.exited).toBe(0);
    };
    await run(
      [
        "git",
        "clone",
        "--quiet",
        "--depth",
        "1",
        "--branch",
        "v0.6.6",
        "https://github.com/anomalyco/opentui",
        checkout,
      ],
      root,
    );
    for (const patch of ["opentui-v0.6.6.patch", "opentui-v0.6.6-pixel-scroll.patch"])
      await run(["git", "apply", join(root, "packages/core/web", patch)]);
    await run([process.execPath, "install", "--frozen-lockfile"]);
    await run([process.execPath, "packages/core/scripts/native-abi.ts", "--check"]);
    await run([process.execPath, "run", "test"], join(checkout, "packages/native"));
    await run([zig, "build", "test-abi", "--summary", "all"], join(checkout, "packages/native"));
  },
  TIMEOUT_MS,
);
