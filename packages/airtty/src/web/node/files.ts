/**
 * The files the in-browser Server can read (docs/WEB.md, `server-seed.json`): a read-only
 * snapshot taken when the site was built, held in memory. `fs.ts` answers from it with
 * Node's shapes (Stats, Dirent, `ENOENT` errors), so Server code written for a disk reads
 * it unchanged. Nothing configures it in a page: there, nothing exists.
 */
import { Buffer } from "node:buffer";
import { basename, dirname, resolve } from "node:path";

type Entry = { kind: "file" | "directory"; size: number; mtimeMs: number; bytes?: Uint8Array };
/** A snapshot entry as the seed file carries it; a file's content in base64. */
export type SnapshotEntry = {
  path: string;
  kind: "file" | "directory";
  size: number;
  mtimeMs: number;
  content?: string;
};

const tree = new Map<string, Entry>();
const ROOT_MTIME = 0;

/** Absolute and normalised, as the snapshot keys its entries; relative to `/`. */
export const normal = (path: unknown) => resolve("/", String(path));

export function configureFiles(entries: readonly SnapshotEntry[]) {
  tree.clear();
  tree.set("/", { kind: "directory", size: 0, mtimeMs: ROOT_MTIME });
  for (const entry of entries) {
    const path = normal(entry.path);
    tree.set(path, {
      kind: entry.kind,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      bytes: entry.content === undefined ? undefined : Buffer.from(entry.content, "base64"),
    });
    // Every ancestor is a directory, listed or not.
    for (let parent = dirname(path); !tree.has(parent); parent = dirname(parent))
      tree.set(parent, { kind: "directory", size: 0, mtimeMs: entry.mtimeMs });
  }
}

/** Node's error for `syscall` on `path`: `code` is what callers test. */
export function fsError(
  code: "ENOENT" | "ENOTDIR" | "EISDIR" | "EINVAL" | "EROFS",
  syscall: string,
  path: unknown,
) {
  const reason = {
    ENOENT: "no such file or directory",
    ENOTDIR: "not a directory",
    EISDIR: "illegal operation on a directory",
    EINVAL: "invalid argument",
    EROFS: "read-only file system (the browser runtime's files are a snapshot)",
  }[code];
  return Object.assign(new Error(`${code}: ${reason}, ${syscall} '${String(path)}'`), {
    code,
    syscall,
    path: String(path),
  });
}

export function entry(path: unknown, syscall: string) {
  const found = tree.get(normal(path));
  if (!found) throw fsError("ENOENT", syscall, path);
  return found;
}

export const exists = (path: unknown) => tree.has(normal(path));

const MODE_DIRECTORY = 0o40755;
const MODE_FILE = 0o100644;
const BLOCK = 4096;

export class Stats {
  readonly size: number;
  readonly mtimeMs: number;
  readonly atimeMs: number;
  readonly ctimeMs: number;
  readonly birthtimeMs: number;
  readonly mtime: Date;
  readonly atime: Date;
  readonly ctime: Date;
  readonly birthtime: Date;
  readonly mode: number;
  readonly blksize = BLOCK;
  readonly nlink = 1;
  readonly uid = 0;
  readonly gid = 0;
  private readonly kind: Entry["kind"];

  constructor(found: Entry) {
    this.kind = found.kind;
    this.size = found.size;
    this.mtimeMs = this.atimeMs = this.ctimeMs = this.birthtimeMs = found.mtimeMs;
    this.mtime = this.atime = this.ctime = this.birthtime = new Date(found.mtimeMs);
    this.mode = found.kind === "directory" ? MODE_DIRECTORY : MODE_FILE;
  }
  isFile() {
    return this.kind === "file";
  }
  isDirectory() {
    return this.kind === "directory";
  }
  isSymbolicLink() {
    return false;
  }
  isFIFO() {
    return false;
  }
  isSocket() {
    return false;
  }
  isBlockDevice() {
    return false;
  }
  isCharacterDevice() {
    return false;
  }
}

export class Dirent {
  readonly name: string;
  readonly parentPath: string;
  private readonly kind: Entry["kind"];

  constructor(path: string, found: Entry) {
    this.name = basename(path);
    this.parentPath = dirname(path);
    this.kind = found.kind;
  }
  isFile() {
    return this.kind === "file";
  }
  isDirectory() {
    return this.kind === "directory";
  }
  isSymbolicLink() {
    return false;
  }
}

/** The names in `path`, or Dirents with `withFileTypes`, in the snapshot's order. */
export function list(path: unknown, withFileTypes: true): Dirent[];
export function list(path: unknown, withFileTypes: false): string[];
export function list(path: unknown, withFileTypes: boolean): string[] | Dirent[] {
  const directory = normal(path);
  if (entry(path, "scandir").kind !== "directory") throw fsError("ENOTDIR", "scandir", path);
  const children = [...tree.entries()].filter(
    ([child]) => child !== directory && dirname(child) === directory,
  );
  return withFileTypes
    ? children.map(([child, found]) => new Dirent(child, found))
    : children.map(([child]) => basename(child));
}

/** A file's bytes. */
export function bytesOf(path: unknown) {
  const found = entry(path, "open");
  if (found.kind === "directory") throw fsError("EISDIR", "read", path);
  return Buffer.from(found.bytes ?? new Uint8Array());
}

/** A file's bytes, or its text in `encoding`. */
export const read = (path: unknown, encoding?: BufferEncoding) =>
  encoding ? bytesOf(path).toString(encoding) : bytesOf(path);
