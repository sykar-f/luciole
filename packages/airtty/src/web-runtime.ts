/**
 * The web runtime of this runtime ABI (docs/WEB.md, W8 and decision 4), prepared once in
 * `$XDG_CACHE_HOME/airtty/web/<abi>/` and copied by `airtty build --web`: OpenTUI's sources
 * at the version the ABI pins, patched for WebAssembly (`web/opentui-*.patch`), its core
 * built with Zig into opentui.wasm, and the page bundled against them (src/web/build.ts).
 *
 * The first preparation needs the network (git) and Zig at the version OpenTUI requires;
 * the next ones reuse the cache. The entry appears in one rename: an interrupted build
 * leaves nothing behind.
 */
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { ABI_KEY, ABI_PACKAGES } from "./abi";
import { defaultCache } from "./compile";
import { buildWebRuntime, WEB_RUNTIME_FILES } from "./web/build";

const OPENTUI_TAG = `v${ABI_PACKAGES["@opentui/core"]}`;
const OPENTUI_REPOSITORY = "https://github.com/anomalyco/opentui";
const OPENTUI_PATCH = resolve(import.meta.dir, `../web/opentui-${OPENTUI_TAG}.patch`);
/** The Zig OpenTUI's build.zig accepts, exactly. */
const ZIG_VERSION = "0.16.0";

export const webRuntimeDirectory = (cache = defaultCache()) => join(cache, "web", ABI_KEY);

function run(command: readonly string[], cwd: string) {
  const result = Bun.spawnSync([...command], { cwd, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed (${result.exitCode})`);
}
const succeeds = (command: readonly string[], cwd: string) =>
  Bun.spawnSync([...command], { cwd, stdout: "ignore", stderr: "ignore" }).exitCode === 0;

function checkZig(zig: string) {
  const version = Bun.spawnSync([zig, "version"], { stdout: "pipe", stderr: "ignore" });
  const found = version.exitCode === 0 ? version.stdout.toString().trim() : undefined;
  if (found !== ZIG_VERSION)
    throw new Error(
      `The web runtime builds OpenTUI's core with Zig ${ZIG_VERSION}; ${found ? `${zig} is ${found}` : `${zig} was not found`}. Set ZIG to a Zig ${ZIG_VERSION} executable.`,
    );
}

/** OpenTUI's sources at the pinned tag, patched, with opentui.wasm built. */
function prepareOpenTui(checkout: string, zig: string) {
  if (!existsSync(join(checkout, ".git")))
    run(
      [
        "git",
        "clone",
        "--quiet",
        "--depth",
        "1",
        "--branch",
        OPENTUI_TAG,
        OPENTUI_REPOSITORY,
        checkout,
      ],
      ".",
    );
  if (!succeeds(["git", "apply", "--reverse", "--check", OPENTUI_PATCH], checkout))
    run(["git", "apply", OPENTUI_PATCH], checkout);
  run(["bun", "install", "--frozen-lockfile"], checkout);
  const native = join(checkout, "packages/native");
  run(["sh", "scripts/prepare-zig-deps.sh"], native);
  run([zig, "build", "-Dlibrary-target=wasm32-wasi", "-Doptimize=ReleaseSmall"], native);
  return join(native, "lib/wasm32-wasi/opentui.wasm");
}

/** This ABI's web runtime, built on first use; its directory. */
export async function prepareWebRuntime({
  cache = defaultCache(),
  zig = process.env.ZIG ?? "zig",
}: { cache?: string; zig?: string } = {}) {
  const directory = webRuntimeDirectory(cache);
  if (existsSync(join(directory, "web-runtime.json"))) return directory;
  checkZig(zig);
  const checkout = join(cache, "web", `opentui-${OPENTUI_TAG}`);
  mkdirSync(join(cache, "web"), { recursive: true });
  const wasm = prepareOpenTui(checkout, zig);
  const temporary = `${directory}.${process.pid}.tmp`;
  rmSync(temporary, { recursive: true, force: true });
  try {
    await buildWebRuntime({ checkout, wasm, outdir: temporary });
    renameSync(temporary, directory);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  return directory;
}

/** Copies this ABI's web runtime next to a build's other outputs (`<output>/web`). */
export async function installWebRuntime(
  output: string,
  options?: { cache?: string; zig?: string },
) {
  const source = await prepareWebRuntime(options);
  const target = join(output, "web");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const name of [...WEB_RUNTIME_FILES, "runtime.js.map", "web-runtime.json"])
    await Bun.write(join(target, name), Bun.file(join(source, name)));
  return target;
}
