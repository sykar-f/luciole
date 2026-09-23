import { realpathSync } from "node:fs";
import { lstat, open, readdir, readlink, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";
import type {
  Entry,
  EntryKind,
  ImageFormat,
  ImageTarget,
  Listing,
  Preview,
} from "../components/model";
import { dimensions, thumbnail } from "./thumbnails";

// The explorer root: FILES_ROOT, or the directory the Server was started from. Resolved
// once, symlinks included, so that every later path is compared against the real one.
const RootSchema = z.string().min(1).optional();
export const root = realpathSync(
  resolve(RootSchema.parse(process.env.FILES_ROOT) ?? process.cwd()),
);

// A listing sends at most this many rows; a directory preview names fewer.
const LISTING_MAX = 5000,
  PREVIEW_ENTRIES = 200;
// Text is previewed from its head; images travel whole to the Client, which decodes them.
const TEXT_BYTES = 262_144, // 256 KiB
  TEXT_LINES = 4000,
  // Before the Client has measured its pane: a thumbnail for a medium-sized preview.
  DEFAULT_TARGET = { width: 640, height: 480 };
// Binary detection looks for a NUL byte in the first block; the hex dump shows 32 rows.
const SNIFF_BYTES = 8000,
  HEX_ROW = 16,
  HEX_ROWS = 32,
  MAGIC_BYTES = 12,
  PRINTABLE_FIRST = 0x20,
  PRINTABLE_END = 0x7f,
  HEX_CELL = 3,
  OFFSET_DIGITS = 8,
  HEX = 16;
// Signatures at the start of each image format (WebP: `RIFF`, a size, then `WEBP`).
const PNG_FIRST = 0x89,
  JPEG_MARKER = 0xff,
  JPEG_START = 0xd8,
  TAG = 4,
  WEBP_TAG = 8;

/**
 * Maps a path sent by the Client to an absolute path inside the root, or `null`. The
 * argument is untrusted: `..`, absolute paths and symlinks that leave the root are refused
 * after resolution, not by looking at the text.
 */
export async function inside(relative: unknown): Promise<string | null> {
  if (typeof relative !== "string" || relative.includes("\0") || isAbsolute(relative)) return null;
  try {
    const real = await realpath(join(root, relative));
    return real === root || real.startsWith(root + sep) ? real : null;
  } catch {
    return null;
  }
}

const kindOf = (s: {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): EntryKind =>
  s.isSymbolicLink() ? "symlink" : s.isDirectory() ? "directory" : s.isFile() ? "file" : "other";

async function entry(directory: string, parent: string, name: string): Promise<Entry | null> {
  const absolute = join(directory, name);
  try {
    const info = await lstat(absolute);
    const row: Entry = {
      name,
      path: parent ? `${parent}/${name}` : name,
      kind: kindOf(info),
      size: info.size,
      modified: info.mtimeMs,
      mode: info.mode,
    };
    if (row.kind !== "symlink") return row;
    row.target = await readlink(absolute).catch(() => undefined);
    const target = await stat(absolute).catch(() => null);
    if (target) {
      row.targetKind = kindOf(target);
      row.size = target.size;
    }
    return row;
  } catch {
    // Removed between readdir and lstat: the listing is a snapshot, skip it.
    return null;
  }
}

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const isDirectoryLike = (e: Entry) =>
  e.kind === "directory" || (e.kind === "symlink" && e.targetKind === "directory");

/** A directory under the root, directories first; `null` when it is not one. */
export async function list(relative: string): Promise<Listing | null> {
  const directory = await inside(relative);
  if (!directory || !(await stat(directory)).isDirectory()) return null;
  const names = (await readdir(directory)).slice(0, LISTING_MAX + 1);
  const entries = (
    await Promise.all(names.slice(0, LISTING_MAX).map((name) => entry(directory, relative, name)))
  ).filter((e): e is Entry => e !== null);
  entries.sort(
    (a, b) =>
      Number(isDirectoryLike(b)) - Number(isDirectoryLike(a)) || byName.compare(a.name, b.name),
  );
  return { root, path: relative, entries, truncated: names.length > LISTING_MAX };
}

function imageFormat(head: Uint8Array): ImageFormat | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...head.subarray(from, to));
  if (head[0] === PNG_FIRST && ascii(1, TAG) === "PNG") return "png";
  if (head[0] === JPEG_MARKER && head[1] === JPEG_START && head[2] === JPEG_MARKER) return "jpeg";
  if (ascii(0, TAG) === "GIF8") return "gif";
  if (ascii(0, TAG) === "RIFF" && ascii(WEBP_TAG, WEBP_TAG + TAG) === "WEBP") return "webp";
  return null;
}

// Filetypes OpenTUI highlights with its bundled tree-sitter grammars; others stay plain.
const LANGUAGES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "javascript",
  md: "markdown",
  zig: "zig",
};
const languageOf = (path: string) => {
  const dot = path.lastIndexOf(".");
  return LANGUAGES[dot > 0 ? path.slice(dot + 1).toLowerCase() : ""] ?? "text";
};

function hexDump(bytes: Uint8Array) {
  const rows: string[] = [];
  for (let offset = 0; offset < bytes.length && rows.length < HEX_ROWS; offset += HEX_ROW) {
    const row = bytes.subarray(offset, offset + HEX_ROW);
    const hex = Array.from(row, (b) => b.toString(HEX).padStart(2, "0")).join(" ");
    const text = Array.from(row, (b) =>
      b >= PRINTABLE_FIRST && b < PRINTABLE_END ? String.fromCharCode(b) : ".",
    );
    rows.push(
      `${offset.toString(HEX).padStart(OFFSET_DIGITS, "0")}  ${hex.padEnd(HEX_ROW * HEX_CELL - 1)}  ${text.join("")}`,
    );
  }
  return rows;
}

async function readHead(path: string, length: number) {
  const file = await open(path, "r");
  try {
    const buffer = new Uint8Array(length);
    const { bytesRead } = await file.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

/** What the preview pane shows for one path under the root. */
export async function preview(
  relative: string,
  target: ImageTarget = DEFAULT_TARGET,
): Promise<Preview> {
  const path = await inside(relative);
  if (!path) return { kind: "unavailable", reason: "Outside the explorer root, or gone" };
  const info = await stat(path);
  if (info.isDirectory()) {
    const names = await readdir(path, { withFileTypes: true });
    const entries = names
      .map((d) => ({ name: d.name, kind: kindOf(d) }))
      .sort((a, b) => byName.compare(a.name, b.name));
    return { kind: "directory", entries: entries.slice(0, PREVIEW_ENTRIES), total: entries.length };
  }
  // A FIFO or a device would block (or never end) on read: never open one.
  if (!info.isFile()) return { kind: "unavailable", reason: "Special file: not read" };
  if (info.size === 0) return { kind: "empty" };
  const format = imageFormat(await readHead(path, MAGIC_BYTES));
  if (format) {
    const file = { size: info.size, modified: info.mtimeMs };
    try {
      const [shown, reduced] = await Promise.all([dimensions(path), thumbnail(path, file, target)]);
      return { kind: "image", format, ...shown, thumbnail: reduced };
    } catch {
      return { kind: "unavailable", reason: `Could not decode this ${format.toUpperCase()}` };
    }
  }
  const head = await readHead(path, TEXT_BYTES);
  if (head.subarray(0, SNIFF_BYTES).includes(0)) return { kind: "binary", hex: hexDump(head) };
  const lines = new TextDecoder().decode(head).split("\n");
  // A cut in the middle of the last line would show half of it; a final newline ends the
  // last line rather than starting an empty one.
  const cut = info.size > head.length;
  if (cut || lines.at(-1) === "") lines.pop();
  const shown = lines.slice(0, TEXT_LINES);
  return {
    kind: "text",
    language: languageOf(path),
    content: shown.join("\n"),
    lines: shown.length,
    truncated: cut || lines.length > TEXT_LINES,
  };
}

/** A thumbnail of the image at `relative` for another pane size (zoom, resize). */
export async function resized(relative: string, target: ImageTarget) {
  const path = await inside(relative);
  if (!path) return null;
  const info = await stat(path);
  if (!info.isFile() || !imageFormat(await readHead(path, MAGIC_BYTES))) return null;
  return thumbnail(path, { size: info.size, modified: info.mtimeMs }, target);
}
