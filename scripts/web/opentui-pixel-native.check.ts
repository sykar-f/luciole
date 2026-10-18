/** Selected routine native proof; no stress or timing tests.
 * On this Mac, set DEVELOPER_DIR=/Library/Developer/CommandLineTools:
 * Xcode 27 headers fail Zig 0.16 libc++ compilation on INFINITY.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { openTuiCheckoutDirectory } from "../../packages/core/src/web-runtime";

const TIMEOUT_MS = 240_000;
const CLEANUP_MS = 5_000;
const root = resolve(import.meta.dir, "../..");
const checkout = join(
  mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "pixel-native-")),
  "opentui",
);
const native = join(checkout, "packages/native");
const zig = process.env["ZIG"] ?? "zig";
let prepared = false;
async function run(command: string[], cwd = checkout) {
  const child = Bun.spawn(command, {
    cwd,
    env: { ...process.env, PATH: `${dirname(zig)}:${process.env["PATH"] ?? ""}` },
    detached: true,
    stdout: "inherit",
    stderr: "inherit",
    signal: AbortSignal.timeout(TIMEOUT_MS - CLEANUP_MS),
  });
  try {
    expect(await child.exited).toBe(0);
  } finally {
    // A compiler driver can leave descendants after a timeout.
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
}
test(
  "OpenTUI pixel patch: generated ABI",
  async () => {
    // Clone upstream Git objects, never the cache's patched working files.
    const source = openTuiCheckoutDirectory();
    await run(
      existsSync(join(source, ".git"))
        ? ["git", "clone", "--quiet", "--shared", source, checkout]
        : [
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
    await run([process.execPath, "run", "prepare:zig"], native);
    prepared = true;
  },
  TIMEOUT_MS,
);
for (const group of ["Pixel", "Scene", "renderer", "Session"])
  test(
    `OpenTUI pixel patch: native ${group}`,
    async () => {
      expect(prepared).toBe(true);
      await run([zig, "build", "test", `-Dtest-filter=${group}`, "--summary", "all"], native);
    },
    TIMEOUT_MS,
  );
test(
  "OpenTUI pixel patch: C ABI",
  async () => {
    expect(prepared).toBe(true);
    await run([zig, "build", "test-abi", "--summary", "all"], native);
  },
  TIMEOUT_MS,
);
