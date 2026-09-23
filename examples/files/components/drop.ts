import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { FINGERPRINT_BYTES, type Fingerprint } from "./model";

// Runs in the Client, on the terminal's machine: a file dropped on the terminal is a path
// of *this* machine, which the Server may not share. Only imported by Client Components.

/**
 * Terminals paste a dropped file as its path: shell-escaped (`My\ File.png`, Ghostty,
 * Terminal.app), quoted (`'My File.png'`), or as a `file://` URL. Several files are
 * separated by spaces or newlines.
 */
export function droppedPaths(text: string): string[] {
  const words: string[] = [];
  let word = "",
    quote = "",
    started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = "";
      else if (c === "\\" && quote === '"' && i + 1 < text.length) word += text[++i];
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (c === "\\" && i + 1 < text.length) {
      word += text[++i];
      started = true;
    } else if (/\s/.test(c)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += c;
      started = true;
    }
  }
  if (started) words.push(word);
  return words.map((w) => (w.startsWith("file://") ? fileURLToPath(w) : w));
}

export type Dropped = { name: string; size: number; source: Fingerprint };

async function head(path: string) {
  const file = await open(path, "r");
  try {
    const buffer = new Uint8Array(FINGERPRINT_BYTES);
    const { bytesRead } = await file.read(buffer, 0, FINGERPRINT_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

/** The dropped paths that are regular files here; `null` if the paste is not a drop. */
export async function inspectDrop(
  text: string,
): Promise<{ files: Dropped[]; skipped: string[] } | null> {
  const paths = droppedPaths(text.trim());
  if (!paths.length || !paths.every((p) => isAbsolute(p))) return null;
  const files: Dropped[] = [];
  const skipped: string[] = [];
  for (const path of paths) {
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) {
      skipped.push(basename(path));
      continue;
    }
    files.push({
      name: basename(path),
      size: info.size,
      source: {
        path,
        dev: info.dev,
        ino: info.ino,
        size: info.size,
        modified: info.mtimeMs,
        sha256: createHash("sha256")
          .update(await head(path))
          .digest("hex"),
      },
    });
  }
  return { files, skipped };
}

/** The whole file, for a copy to a Server that cannot read it. */
export async function readDropped(path: string) {
  return new Uint8Array(await Bun.file(path).arrayBuffer());
}
