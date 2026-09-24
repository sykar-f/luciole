import "server-only";
import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { Doc, DocEntry, Library } from "../components/model";
import { reflow } from "./reflow";

// The library is the file or directory named by MD_PATH (the working directory by
// default). Only Markdown files under it are listed and read; nothing is cached, so a
// page always shows the file as it is on disk.
const IGNORED = new Set(["node_modules", ".git"]);
const MARKDOWN = /\.(md|markdown)$/i;
const MAX_DOCS = 2000,
  MAX_DEPTH = 16,
  // 2 MiB: larger files are shown truncated.
  MAX_BYTES = 2_097_152;
// Editors write a file in several steps: one reload per burst of changes.
const SETTLE_MS = 120;
// A quiet live response never learns that its Client left: the runtime notices a closed
// connection only when it writes. Repeating the current version this often bounds how
// long a watcher outlives its Client; the Client ignores a value it already has.
const HEARTBEAT_MS = 10_000;

// An empty MD_PATH means the default, like an unset one. The heartbeat is shortened by
// the PTY test only.
const Env = z.object({
  MD_PATH: z.string().optional(),
  MDREADER_HEARTBEAT_MS: z.coerce.number().int().positive().optional(),
});
const env = () => Env.parse(process.env);

type Location = { root: string; file: string | null; problem: string | null };

async function locate(): Promise<Location> {
  const target = resolve(env().MD_PATH || process.cwd());
  const info = await stat(target).catch(() => null);
  if (!info) return { root: target, file: null, problem: `${target} does not exist` };
  if (info.isDirectory()) return { root: target, file: null, problem: null };
  if (!MARKDOWN.test(target))
    return { root: dirname(target), file: null, problem: `${target} is not a Markdown file` };
  return { root: dirname(target), file: basename(target), problem: null };
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });

/** Depth first: the files of a directory, then its subdirectories, both by name. */
async function scan(root: string) {
  const docs: DocEntry[] = [];
  let truncated = false;
  async function visit(dir: string, depth: number) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const files = entries
      .filter((e) => (e.isFile() || e.isSymbolicLink()) && MARKDOWN.test(e.name))
      .map((e) => e.name)
      .sort(byName);
    for (const name of files) {
      if (docs.length >= MAX_DOCS) return void (truncated = true);
      // A link is listed when it points to a file; linked directories are not followed.
      const info = await stat(join(dir, name)).catch(() => null);
      if (info?.isFile())
        docs.push({ path: relative(root, join(dir, name)).split(sep).join("/"), size: info.size });
    }
    if (depth >= MAX_DEPTH) return;
    const dirs = entries
      .filter((e) => e.isDirectory() && !IGNORED.has(e.name))
      .map((e) => e.name)
      .sort(byName);
    for (const name of dirs) await visit(join(dir, name), depth + 1);
  }
  await visit(root, 0);
  return { docs, truncated };
}

const display = (path: string) => {
  const home = homedir();
  return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
};

export async function library(): Promise<Library> {
  const { root, file, problem } = await locate();
  const base = { root: display(root), single: file !== null, truncated: false };
  if (problem) return { ...base, docs: [], home: null, problem };
  if (file) {
    const info = await stat(join(root, file));
    return { ...base, docs: [{ path: file, size: info.size }], home: file, problem: null };
  }
  const { docs, truncated } = await scan(root);
  const top = docs.filter((d) => !d.path.includes("/"));
  const home =
    top.find((d) => /^readme\.md$/i.test(d.path)) ??
    top.find((d) => /^index\.md$/i.test(d.path)) ??
    docs[0];
  return { ...base, docs, truncated, home: home?.path ?? null, problem: null };
}

/**
 * A document of the library, or `null`. The path comes from the Client: it must name a
 * Markdown file under the root, outside ignored directories, in single-file mode the file.
 */
export async function readDoc(path: string): Promise<Doc | null> {
  const { root, file, problem } = await locate();
  if (problem || typeof path !== "string" || !MARKDOWN.test(path) || isAbsolute(path)) return null;
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === ".." || IGNORED.has(s))) return null;
  if (file && path !== file) return null;
  const absolute = resolve(root, ...segments);
  const inside = relative(root, absolute);
  if (inside.startsWith("..") || isAbsolute(inside)) return null;
  const info = await stat(absolute).catch(() => null);
  if (!info?.isFile()) return null;
  const bytes = await readFile(absolute);
  const truncated = bytes.length > MAX_BYTES;
  const text = new TextDecoder()
    .decode(truncated ? bytes.subarray(0, MAX_BYTES) : bytes)
    .replace(/\r\n?/g, "\n");
  const lines = text.split("\n").length;
  return { path, content: reflow(text), lines, size: info.size, modified: info.mtimeMs, truncated };
}

/** Whether a change reported by the watcher can affect the list or a document. */
function relevant(name: string | null, file: string | null) {
  if (file) return name === null || name === file;
  if (name === null) return true;
  const parts = name.split(/[\\/]/);
  if (parts.some((p) => IGNORED.has(p))) return false;
  // A renamed or removed directory has no extension and may hold documents.
  return MARKDOWN.test(name) || !parts.at(-1)?.includes(".");
}

/**
 * Change counter of the library, one value per settled burst of changes. Returned as a
 * plain iterator rather than an async generator: Flight stops a live response with
 * `throw()`, and a generator waiting for the next change would only see it after that
 * change. Here `throw()` and `return()` close the watcher at once.
 */
export async function libraryChanges(): Promise<AsyncIterableIterator<number>> {
  const { root, file, problem } = await locate();
  let version = 0,
    delivered = 0,
    closed = false;
  let wake: ((result: IteratorResult<number>) => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | null = null;
  const finished: IteratorResult<number> = { done: true, value: undefined };
  const close = () => {
    closed = true;
    clearTimeout(timer);
    clearTimeout(heartbeat);
    watcher?.close();
    wake?.(finished);
    wake = null;
  };
  const changed = () => {
    version++;
    if (!wake) return;
    clearTimeout(heartbeat);
    delivered = version;
    const resolveNext = wake;
    wake = null;
    resolveNext({ done: false, value: version });
  };
  // Nothing to watch: the stream ends at once and the chrome says the watch stopped.
  if (problem) closed = true;
  else {
    // Watch the directory of a single file: editors often replace the file itself.
    watcher = watch(root, { recursive: !file }, (_event, name) => {
      if (closed || !relevant(name ? String(name) : null, file)) return;
      clearTimeout(timer);
      timer = setTimeout(changed, SETTLE_MS);
    });
    watcher.on("error", close);
  }
  const iterator: AsyncIterableIterator<number> = {
    [Symbol.asyncIterator]: () => iterator,
    next: () => {
      if (closed) return Promise.resolve(finished);
      if (version > delivered) {
        delivered = version;
        return Promise.resolve({ done: false, value: version });
      }
      return new Promise((resolveNext) => {
        wake = resolveNext;
        heartbeat = setTimeout(() => {
          wake = null;
          resolveNext({ done: false, value: delivered });
        }, env().MDREADER_HEARTBEAT_MS ?? HEARTBEAT_MS);
      });
    },
    return: () => {
      close();
      return Promise.resolve(finished);
    },
    throw: () => {
      close();
      return Promise.resolve(finished);
    },
  };
  return iterator;
}
