/**
 * Build the universal macOS PTY launcher with Apple's system clang.
 * `bun scripts/build-pty.ts --check` compares a fresh build and the shipped binary
 * with dist/SHA256SUMS. No compiler is needed on a user's machine.
 */
import { mkdir, mkdtemp, readFile, copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") throw new Error("Build luciole-pty on macOS with Xcode tools");
const root = fileURLToPath(new URL("../packages/core/native/luciole-pty/", import.meta.url));
const dist = join(root, "dist");
const temporary = await mkdtemp(join(tmpdir(), "luciole-pty-build-"));
const binary = join(temporary, "luciole-pty");
// macOS 13.0: LC_BUILD_VERSION of the official Bun 1.4.x runtime used by luciole.
// A fixed output name and no UUID keep link metadata independent of the build path.
const result = Bun.spawnSync(
  [
    "/usr/bin/clang",
    "-Os",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-arch",
    "arm64",
    "-arch",
    "x86_64",
    "-mmacosx-version-min=13.0",
    "-Wl,-no_uuid",
    join(root, "launcher.c"),
    "-o",
    binary,
  ],
  { stdout: "inherit", stderr: "inherit" },
);
if (result.exitCode !== 0) throw new Error("clang could not build luciole-pty");
const sum = async (path: string) =>
  new Bun.CryptoHasher("sha256").update(await Bun.file(path).bytes()).digest("hex") +
  "  luciole-pty\n";
const built = await sum(binary);
if (process.argv.includes("--check")) {
  const expected = await readFile(join(dist, "SHA256SUMS"), "utf8");
  if (built !== expected || (await sum(join(dist, "luciole-pty"))) !== expected)
    throw new Error("luciole-pty differs from SHA256SUMS; use the recorded Apple toolchain");
  console.log("Reproduced luciole-pty (both architectures, full binary SHA-256)");
} else {
  await mkdir(dist, { recursive: true });
  await copyFile(binary, join(dist, "luciole-pty"));
  await writeFile(join(dist, "SHA256SUMS"), built);
  console.log(built.trim());
}
