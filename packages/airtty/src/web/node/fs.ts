/**
 * `node:fs` and `node:fs/promises` in a page and in the in-browser Server. Reads answer
 * from the read-only snapshot of files.ts: empty in a page, where OpenTUI only checks
 * whether files exist; the site's `server-seed.json` in the Server (docs/WEB.md). Writes
 * that OpenTUI makes for logs and caches are inert; any other change says the files are
 * a snapshot. `watch` watches nothing: a snapshot never changes.
 */
import { EventEmitter } from "node:events";
import { bytesOf, Dirent, entry, exists, fsError, list, normal, read, Stats } from "./files";

type Encoding = BufferEncoding | { encoding?: BufferEncoding | null } | null | undefined;
const encodingOf = (options: Encoding) =>
  (typeof options === "string" ? options : options?.encoding) ?? undefined;
type ListOptions = { withFileTypes?: boolean } | BufferEncoding | undefined;
const typed = (options: ListOptions) =>
  typeof options === "object" && options.withFileTypes === true;

const inert = () => undefined;
const inertAsync = async () => undefined;
const readOnly = (syscall: string) => (path?: unknown) => {
  throw fsError("EROFS", syscall, path);
};
const readOnlyAsync = (syscall: string) => async (path?: unknown) => readOnly(syscall)(path);

export const existsSync = (path: unknown) => exists(path);
export const readFileSync = (path: unknown, options?: Encoding) => read(path, encodingOf(options));
/** Names, or Dirents with `withFileTypes`, as Node's overloads type them. */
export function readdirSync(path: unknown, options: { withFileTypes: true }): Dirent[];
export function readdirSync(path: unknown, options?: ListOptions): string[];
export function readdirSync(path: unknown, options?: ListOptions): string[] | Dirent[] {
  return typed(options) ? list(path, true) : list(path, false);
}
function readdir(path: unknown, options: { withFileTypes: true }): Promise<Dirent[]>;
function readdir(path: unknown, options?: ListOptions): Promise<string[]>;
async function readdir(path: unknown, options?: ListOptions): Promise<string[] | Dirent[]> {
  return readdirSync(path, options);
}
export const statSync = (path: unknown) => new Stats(entry(path, "stat"));
export const lstatSync = (path: unknown) => new Stats(entry(path, "lstat"));
export const realpathSync = (path: unknown) => (entry(path, "realpath"), normal(path));
export const readlinkSync = (path: unknown) => {
  entry(path, "readlink");
  throw fsError("EINVAL", "readlink", path);
};
export const writeFileSync = inert;
export const appendFileSync = inert;
export const mkdirSync = inert;
export const rmSync = inert;
export const unlinkSync = inert;
export const renameSync = readOnly("rename");
export const cpSync = readOnly("cp");
export const symlinkSync = readOnly("symlink");
export const mkdtempSync = readOnly("mkdtemp");
export const createWriteStream = readOnly("open");

/** A watcher that never fires: the snapshot does not change. */
class Watcher extends EventEmitter {
  close() {
    this.removeAllListeners();
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}
export const watch = () => new Watcher();

/** What `fs/promises.open` returns, for reading: the snapshot's bytes, by position. */
class FileHandle {
  private readonly path: unknown;
  constructor(path: unknown) {
    this.path = path;
  }
  async read(buffer: Uint8Array, offset = 0, length = buffer.length - offset, position = 0) {
    const bytes = bytesOf(this.path);
    const slice = bytes.subarray(position ?? 0, (position ?? 0) + length);
    buffer.set(slice, offset);
    return { bytesRead: slice.length, buffer };
  }
  async readFile(options?: Encoding) {
    return read(this.path, encodingOf(options));
  }
  async stat() {
    return new Stats(entry(this.path, "fstat"));
  }
  async close() {}
}

export const promises = {
  readFile: async (path: unknown, options?: Encoding) => readFileSync(path, options),
  readdir,
  stat: async (path: unknown) => statSync(path),
  lstat: async (path: unknown) => lstatSync(path),
  realpath: async (path: unknown) => realpathSync(path),
  readlink: async (path: unknown) => readlinkSync(path),
  access: async (path: unknown) => void entry(path, "access"),
  open: async (path: unknown, flags: string = "r") => {
    if (flags !== "r") throw fsError("EROFS", "open", path);
    entry(path, "open");
    return new FileHandle(path);
  },
  rename: readOnlyAsync("rename"),
  mkdtemp: readOnlyAsync("mkdtemp"),
  chmod: readOnlyAsync("chmod"),
  copyFile: readOnlyAsync("copyfile"),
  link: readOnlyAsync("link"),
  unlink: inertAsync,
  rm: inertAsync,
  writeFile: inertAsync,
  mkdir: inertAsync,
};
export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, COPYFILE_EXCL: 1 };
export default {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  lstatSync,
  realpathSync,
  readlinkSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  renameSync,
  cpSync,
  symlinkSync,
  mkdtempSync,
  createWriteStream,
  watch,
  constants,
  promises,
};
