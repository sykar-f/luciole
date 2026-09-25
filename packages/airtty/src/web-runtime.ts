/**
 * The web runtime of this runtime ABI (docs/WEB.md, W8 and decision 4), prepared once per
 * framework in `$XDG_CACHE_HOME/airtty/web/<abi>-<framework>/` and copied by `airtty build
 * --web`: OpenTUI's sources at the version the ABI pins, patched for WebAssembly
 * (`web/opentui-*.patch`), its core built with Zig into opentui.wasm, and the page bundled
 * against them (src/web/build.ts).
 *
 * The first preparation needs the network (git) and Zig at the version OpenTUI requires;
 * the next ones reuse the cache. The entry appears in one rename: an interrupted build
 * leaves nothing behind.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ABI_KEY, ABI_PACKAGES, APP_MANIFEST, AppManifest } from "./abi";
import { defaultCache } from "./compile";
import { frameworkHash } from "./framework-hash";
import { buildWebRuntime, WEB_RUNTIME_FILES } from "./web/build";
import { WEB_SERVER_FILE } from "./web/server-build";

const OPENTUI_TAG = `v${ABI_PACKAGES["@opentui/core"]}`;
const OPENTUI_REPOSITORY = "https://github.com/anomalyco/opentui";
const OPENTUI_PATCH = resolve(import.meta.dir, `../web/opentui-${OPENTUI_TAG}.patch`);
/** The Zig OpenTUI's build.zig accepts, exactly. */
const ZIG_VERSION = "0.16.0";

const HASH_PREFIX = 16;
/** One entry per ABI key and framework: the page is the framework's code too. */
export const webRuntimeDirectory = async (cache = defaultCache()) =>
  join(cache, "web", `${ABI_KEY}-${(await frameworkHash()).slice(0, HASH_PREFIX)}`);

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
  const directory = await webRuntimeDirectory(cache);
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

const copy = (from: string, to: string, names: readonly string[]) =>
  Promise.all(names.map((name) => Bun.write(join(to, name), Bun.file(join(from, name)))));

/**
 * Copies this ABI's web runtime next to a build's other outputs (`<output>/web`). `local`:
 * a static site instead, with the in-browser Server (`web-server/`) and the application
 * bundle (`app/`) beside the page, which it tells to use them.
 */
export async function installWebRuntime(
  output: string,
  { local = false, ...options }: { local?: boolean; cache?: string; zig?: string } = {},
) {
  const source = await prepareWebRuntime(options);
  const target = join(output, "web");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(join(target, "app"), { recursive: true });
  await copy(source, target, [...WEB_RUNTIME_FILES, "runtime.js.map", "web-runtime.json"]);
  if (!local) return target;
  await copy(join(output, "web-server"), target, [
    WEB_SERVER_FILE,
    `${WEB_SERVER_FILE}.map`,
    "sqlite3.wasm",
  ]);
  const manifest = AppManifest.parse(
    JSON.parse(readFileSync(join(output, "app", APP_MANIFEST), "utf8")),
  );
  await copy(join(output, "app"), join(target, "app"), [APP_MANIFEST, manifest.bundle]);
  const page = readFileSync(join(source, "index.html"), "utf8");
  const marked = page.replace(
    '<div id="airtty"></div>',
    '<div id="airtty" data-server="worker"></div>',
  );
  if (marked === page) throw new Error(`${source}/index.html has no #airtty element to mark`);
  writeFileSync(join(target, "index.html"), marked);
  return target;
}
