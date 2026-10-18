/**
 * The web runtime of this runtime ABI (docs/WEB.md, W8 and decision 4), prepared once per
 * framework in `$XDG_CACHE_HOME/luciole/web/<abi>-<framework>/` and copied by `luciole build
 * --web`: OpenTUI's sources at the version the ABI pins, patched for WebAssembly
 * (`web/opentui-*.patch`), its core built with Zig into opentui.wasm, and the page bundled
 * against them (src/web/build.ts).
 *
 * The first preparation needs the network (git) and Zig at the version OpenTUI requires;
 * the next ones reuse the cache. The entry appears in one rename: an interrupted build
 * leaves nothing behind.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { Database, SQLiteError } from "bun:sqlite";
import { isCode } from "./launcher/lock";
import { ABI_KEY, ABI_PACKAGES, APP_MANIFEST, AppManifest } from "./abi";
import { defaultCache } from "./compile";
import { frameworkHash } from "./framework-hash";
import { buildWebRuntime, TREE_SITTER_DIRECTORY, WEB_RUNTIME_FILES } from "./web/build";
import { WEB_SERVER_FILE } from "./web/server-build";

const OPENTUI_TAG = `v${ABI_PACKAGES["@opentui/core"]}`;
const OPENTUI_REPOSITORY = "https://github.com/anomalyco/opentui";
const OPENTUI_PATCH = resolve(import.meta.dir, `../web/opentui-${OPENTUI_TAG}.patch`);
const PIXEL_SCROLL_PATCH = resolve(
  import.meta.dir,
  `../web/opentui-${OPENTUI_TAG}-pixel-scroll.patch`,
);

/** Source cache identity includes both ordered OpenTUI patches. */
export function openTuiCheckoutDirectory(cache = defaultCache()) {
  const key = createHash("sha256")
    .update(readFileSync(OPENTUI_PATCH))
    .update(readFileSync(PIXEL_SCROLL_PATCH))
    .digest("hex")
    .slice(0, HASH_PREFIX);
  return join(cache, "web", `opentui-${OPENTUI_TAG}-${key}`);
}
/** The Zig OpenTUI's build.zig accepts, exactly. */
const ZIG_VERSION = "0.16.0";

const HASH_PREFIX = 16;
const LOCK_POLL_MS = 25;
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

/** Internal clone seam: callers prepare only complete source checkouts. */
export function prepareOpenTuiCheckout(
  checkout: string,
  repository = OPENTUI_REPOSITORY,
  tag = OPENTUI_TAG,
) {
  if (
    existsSync(join(checkout, ".git")) &&
    succeeds(["git", "rev-parse", "--verify", "HEAD"], checkout)
  ) {
    const tracked = Bun.spawnSync(["git", "ls-tree", "-rz", "--name-only", "HEAD"], {
      cwd: checkout,
      stdout: "pipe",
      stderr: "ignore",
    });
    const files = tracked.stdout.toString().split("\0").filter(Boolean);
    if (
      tracked.exitCode === 0 &&
      files.length &&
      files.every((file) => existsSync(join(checkout, file)))
    )
      return;
  }
  rmSync(checkout, { recursive: true, force: true });
  const temporary = mkdtempSync(`${checkout}.${process.pid}.tmp-`);
  try {
    run(["git", "clone", "--quiet", "--depth", "1", "--branch", tag, repository, temporary], ".");
    renameSync(temporary, checkout);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** OpenTUI's sources at a tag, patched, with opentui.wasm built. Defaults to the ABI pin. */
export function prepareOpenTui(
  checkout: string,
  zig: string,
  { tag = OPENTUI_TAG, patch = OPENTUI_PATCH }: { tag?: string; patch?: string } = {},
) {
  checkZig(zig);
  prepareOpenTuiCheckout(checkout, OPENTUI_REPOSITORY, tag);
  for (const file of patch === OPENTUI_PATCH ? [patch, PIXEL_SCROLL_PATCH] : [patch]) {
    if (!succeeds(["git", "apply", "--reverse", "--check", file], checkout)) {
      run(["git", "apply", "--check", file], checkout);
      run(["git", "apply", file], checkout);
    }
  }
  run(["bun", "install", "--frozen-lockfile"], checkout);
  const native = join(checkout, "packages/native");
  run(["sh", "scripts/prepare-zig-deps.sh"], native);
  run([zig, "build", "-Dlibrary-target=wasm32-wasi", "-Doptimize=ReleaseSmall"], native);
  return join(native, "lib/wasm32-wasi/opentui.wasm");
}

const runtimeComplete = (directory: string) =>
  [...WEB_RUNTIME_FILES, "runtime.js.map", "web-runtime.json", TREE_SITTER_DIRECTORY].every(
    (file) => existsSync(join(directory, file)),
  );

/** Called only while the checkout lock excludes other preparations of this key. */
function removeAbandonedTemporaries(path: string) {
  const prefix = `${basename(path)}.`;
  for (const name of readdirSync(dirname(path))) {
    if (!name.startsWith(prefix)) continue;
    const match = /^(\d+)\.tmp(?:-|$)/.exec(name.slice(prefix.length));
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    try {
      process.kill(pid, 0);
    } catch (error: unknown) {
      if (isCode(error, "ESRCH"))
        rmSync(join(dirname(path), name), { recursive: true, force: true });
    }
  }
}

/** Internal preparation seam; the lock covers the shared checkout and runtime publication. */
export async function prepareWebRuntimeEntry({
  directory,
  checkout,
  build,
  waiting,
}: {
  directory: string;
  checkout: string;
  build: (temporary: string) => Promise<void>;
  waiting?: () => void;
}) {
  mkdirSync(dirname(directory), { recursive: true });
  // SQLite's OS lock is released even on SIGKILL. Keep this file: unlinking it
  // would let a new connection lock a different inode while a waiter uses the old one.
  const lock = new Database(`${checkout}.lock`, { create: true });
  try {
    lock.exec("PRAGMA busy_timeout = 0");
    let told = false;
    for (;;) {
      try {
        lock.exec("BEGIN IMMEDIATE");
        break;
      } catch (error: unknown) {
        if (!(error instanceof SQLiteError) || error.code !== "SQLITE_BUSY") throw error;
      }
      if (!told) waiting?.();
      told = true;
      await Bun.sleep(LOCK_POLL_MS);
    }
    removeAbandonedTemporaries(checkout);
    removeAbandonedTemporaries(directory);
    // buildWebRuntime writes this commit marker last, before atomic publication.
    // Preserve the existing warm-cache contract (including install-time errors).
    if (existsSync(join(directory, "web-runtime.json"))) return directory;
    rmSync(directory, { recursive: true, force: true });
    const temporary = mkdtempSync(`${directory}.${process.pid}.tmp-`);
    try {
      await build(temporary);
      try {
        renameSync(temporary, directory);
      } catch (error: unknown) {
        // Also tolerate a complete entry published by an older, unlocked preparer.
        if (!(isCode(error, "EEXIST") || isCode(error, "ENOTEMPTY"))) throw error;
        if (!runtimeComplete(directory)) {
          // This competing entry was rejected: do not trust its marker on retry.
          rmSync(join(directory, "web-runtime.json"), { force: true });
          throw error;
        }
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
    return directory;
  } finally {
    lock.close();
  }
}

/** This ABI's web runtime, built on first use; its directory. */
export async function prepareWebRuntime({
  cache = defaultCache(),
  zig = process.env["ZIG"] ?? "zig",
}: { cache?: string; zig?: string } = {}) {
  const directory = await webRuntimeDirectory(cache);
  // A patch revision needs a clean source checkout; applying it over an older
  // patched tree can neither pass the reverse check nor apply the new patch.
  const checkout = openTuiCheckoutDirectory(cache);
  return prepareWebRuntimeEntry({
    directory,
    checkout,
    waiting: () =>
      console.error(`luciole web-runtime: waiting for another preparation of ${directory}`),
    async build(temporary) {
      const wasm = prepareOpenTui(checkout, zig);
      await buildWebRuntime({ checkout, wasm, outdir: temporary });
    },
  });
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
  cpSync(join(source, TREE_SITTER_DIRECTORY), join(target, TREE_SITTER_DIRECTORY), {
    recursive: true,
  });
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
    '<div id="luciole"></div>',
    '<div id="luciole" data-server="worker"></div>',
  );
  if (marked === page) throw new Error(`${source}/index.html has no #luciole element to mark`);
  writeFileSync(join(target, "index.html"), marked);
  return target;
}
