/** Shared OpenTUI source preparation, library builds and atomic runtime publication. */
import {
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
import { Database, SQLiteError } from "bun:sqlite";
import { ABI_PACKAGES } from "./abi";
import { isCode } from "./launcher/lock";

export const OPENTUI_TAG = `v${ABI_PACKAGES["@opentui/core"]}`;
export const OPENTUI_REPOSITORY = "https://github.com/anomalyco/opentui";
export const OPENTUI_PATCH = resolve(import.meta.dir, `../web/opentui-${OPENTUI_TAG}.patch`);
export const PIXEL_SCROLL_PATCH = resolve(
  import.meta.dir,
  `../web/opentui-${OPENTUI_TAG}-pixel-scroll.patch`,
);

const ZIG_VERSION = "0.16.0";
const LOCK_POLL_MS = 25;

function run(command: readonly string[], cwd: string, quiet = false, env?: NodeJS.ProcessEnv) {
  const result = Bun.spawnSync([...command], {
    cwd,
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
    stdout: quiet ? "pipe" : "inherit",
    stderr: quiet ? "pipe" : "inherit",
  });
  if (result.exitCode !== 0) {
    if (quiet && result.stderr?.length) console.error(result.stderr.toString().trim());
    throw new Error(`${command.join(" ")} failed (${result.exitCode})`);
  }
}
export function checkZig(zig: string, runtime: string) {
  const version = Bun.spawnSync([zig, "version"], { stdout: "pipe", stderr: "ignore" });
  const found = version.exitCode === 0 ? version.stdout.toString().trim() : undefined;
  if (found !== ZIG_VERSION)
    throw new Error(
      `The ${runtime} builds OpenTUI's core with Zig ${ZIG_VERSION}; ${found ? `${zig} is ${found}` : `${zig} was not found`}. Set ZIG to a Zig ${ZIG_VERSION} executable.`,
    );
}

/** Compare source contents without changing the checkout's real index. */
function patchedSourceTree(checkout: string, tag: string, patches: readonly string[]) {
  if (!existsSync(join(checkout, ".git"))) return;
  const temporary = mkdtempSync(`${checkout}.${process.pid}.tmp-`);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: checkout,
      env: { ...process.env, GIT_INDEX_FILE: join(temporary, "index") },
      stdout: "pipe",
      stderr: "ignore",
    });
    return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
  };
  try {
    const base = git("rev-parse", "--verify", `refs/tags/${tag}^{commit}`);
    if (!base || git("rev-parse", "--verify", "HEAD") !== base) return;
    if (git("read-tree", base) === undefined) return;
    for (const patch of patches) if (git("apply", "--cached", patch) === undefined) return;
    const expected = git("write-tree");
    if (!expected) return;
    // Seed with the expected tree so files added by patches count even when
    // ignored. Include other nonignored untracked files, but keep build output.
    if (git("read-tree", expected) === undefined || git("add", "--all", "--", ".") === undefined)
      return;
    return git("write-tree") === expected ? expected : undefined;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** Internal clone seam: publish and reuse only the exact ordered source stack. */
export function prepareOpenTuiCheckout(
  checkout: string,
  repository = OPENTUI_REPOSITORY,
  tag = OPENTUI_TAG,
  patches: readonly string[] = [],
) {
  mkdirSync(dirname(checkout), { recursive: true });
  const existing = patchedSourceTree(checkout, tag, patches);
  if (existing) return existing;
  rmSync(checkout, { recursive: true, force: true });
  const temporary = mkdtempSync(`${checkout}.${process.pid}.tmp-`);
  try {
    run(
      ["git", "clone", "--quiet", "--depth", "1", "--branch", tag, repository, temporary],
      ".",
      true,
    );
    for (const patch of patches) run(["git", "apply", patch], temporary);
    const tree = patchedSourceTree(temporary, tag, patches);
    if (!tree) throw new Error("Prepared OpenTUI sources do not match the patch stack");
    renameSync(temporary, checkout);
    return tree;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

const SOURCE_TREE_FILE = "opentui-source-tree";
const readSourceTree = (file: string) =>
  existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
/** Build a library only when its artifact lacks matching source provenance. */
export function buildOpenTuiLibrary({
  checkout,
  zig,
  tree,
  artifact,
  options,
  runtime,
  env,
}: {
  checkout: string;
  zig: string;
  tree: string;
  artifact: string;
  options: readonly string[];
  runtime: string;
  env?: NodeJS.ProcessEnv;
}) {
  const native = join(checkout, "packages/native");
  const record = `${artifact}.source-tree`;
  if (existsSync(artifact) && readSourceTree(record) === tree) return artifact;
  checkZig(zig, runtime);
  // A failed rebuild cannot leave a previously accepted provenance record.
  rmSync(record, { force: true });
  rmSync(artifact, { force: true });
  run(["bun", "install", "--frozen-lockfile"], checkout);
  run(["sh", "scripts/prepare-zig-deps.sh"], native, false, env);
  run([zig, "build", ...options], native, false, env);
  writeFileSync(record, `${tree}\n`);
  return artifact;
}

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
export async function publishRuntimeEntry({
  directory,
  checkout,
  marker,
  complete,
  build,
  waiting,
  sourceTree,
}: {
  directory: string;
  checkout: string;
  marker: string;
  complete: (directory: string) => boolean;
  build: (temporary: string) => Promise<void>;
  waiting?: () => void;
  sourceTree?: () => string;
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
    // The runtime key includes the framework and ordered patches. Its recorded
    // validated tree is sufficient provenance; reuse must not need the checkout.
    const hasSource = (path: string) =>
      sourceTree === undefined ||
      /^[a-f0-9]{40}$/.test(readSourceTree(join(path, SOURCE_TREE_FILE)) ?? "");
    if (existsSync(join(directory, marker)) && hasSource(directory)) return directory;
    // A legacy entry has no source provenance and must be rebuilt once.
    const tree = sourceTree?.();
    const matchesSource = (path: string) =>
      tree === undefined || readSourceTree(join(path, SOURCE_TREE_FILE)) === tree;
    rmSync(directory, { recursive: true, force: true });
    const temporary = mkdtempSync(`${directory}.${process.pid}.tmp-`);
    try {
      await build(temporary);
      if (tree !== undefined) writeFileSync(join(temporary, SOURCE_TREE_FILE), `${tree}\n`);
      try {
        renameSync(temporary, directory);
      } catch (error: unknown) {
        // Also tolerate a complete entry published by an older, unlocked preparer.
        if (!(isCode(error, "EEXIST") || isCode(error, "ENOTEMPTY"))) throw error;
        if (!complete(directory) || !matchesSource(directory)) {
          // This competing entry was rejected: do not trust its marker on retry.
          rmSync(join(directory, marker), { force: true });
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
