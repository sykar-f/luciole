/**
 * Builds opentui.wasm from OpenTUI's sources at the version the ABI pins:
 *   OPENTUI_SRC=<dir> [ZIG=<zig 0.16.0>] bun probes/web/opentui-wasm/build-wasm.ts
 * Clones the tag into OPENTUI_SRC when it is empty, applies opentui-v0.5.12.patch once,
 * installs the JS dependencies (build.ts bundles @opentui/core from these sources) and
 * prints the module's path.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const TAG = "v0.5.12";
const REPOSITORY = "https://github.com/anomalyco/opentui";
const PATCH = join(import.meta.dir, `opentui-${TAG}.patch`);
const source = process.env.OPENTUI_SRC;
if (!source) throw new Error("OPENTUI_SRC: where OpenTUI is (or will be) checked out");
const root = resolve(source);
const zig = process.env.ZIG ?? "zig";

function run(command: readonly string[], cwd = root) {
  const result = Bun.spawnSync([...command], { cwd, stdio: ["ignore", "inherit", "inherit"] });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed (${result.exitCode})`);
}
const succeeds = (command: readonly string[]) =>
  Bun.spawnSync([...command], { cwd: root, stdio: ["ignore", "ignore", "ignore"] }).exitCode === 0;

if (!existsSync(join(root, ".git")))
  run(["git", "clone", "--quiet", "--depth", "1", "--branch", TAG, REPOSITORY, root], ".");
if (!succeeds(["git", "apply", "--reverse", "--check", PATCH])) run(["git", "apply", PATCH]);
run(["bun", "install", "--frozen-lockfile"]);
const native = join(root, "packages/native");
run(["sh", "scripts/prepare-zig-deps.sh"], native);
run([zig, "build", "-Dlibrary-target=wasm32-wasi", "-Doptimize=ReleaseSmall"], native);
const wasm = join(native, "lib/wasm32-wasi/opentui.wasm");
console.log(wasm, Bun.file(wasm).size);
