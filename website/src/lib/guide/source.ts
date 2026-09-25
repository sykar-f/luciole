import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// The guide quotes the checkout, never a copy: every excerpt and every file:line is found by
// an anchor at build time, and a missing anchor fails the build instead of drifting silently.
const root = resolve(process.cwd(), existsSync(join(process.cwd(), "packages")) ? "." : "..");
const cache = new Map<string, string[]>();

function lines(path: string): string[] {
  const known = cache.get(path);
  if (known) return known;
  const file = join(root, path);
  if (!existsSync(file)) throw new Error(`Guide : le fichier ${path} n'existe plus.`);
  const read = readFileSync(file, "utf8").split("\n");
  cache.set(path, read);
  return read;
}

/** The 1-based line of the first line containing `find`, searching from `after` if given. */
export function locate(path: string, find: string, after?: string): number {
  const all = lines(path);
  const start = after === undefined ? 0 : locate(path, after);
  const index = all.findIndex((line, i) => i >= start && line.includes(find));
  if (index === -1) {
    throw new Error(
      `Guide : repère ${JSON.stringify(find)} introuvable dans ${path}. Le code a changé : mettre le guide à jour.`,
    );
  }
  return index + 1;
}

export interface Range {
  /** Text on the first line of the excerpt. */
  find: string;
  /** Text on the last line, inclusive, or "^text" for a line starting with it; otherwise `count` lines. */
  until?: string;
  count?: number;
  /** Searches `find` after this anchor, to pick one of several occurrences. */
  after?: string;
}

export function excerpt(path: string, range: Range): { code: string; start: number; end: number } {
  const all = lines(path);
  const start = locate(path, range.find, range.after);
  let end = start + (range.count ?? 1) - 1;
  if (range.until !== undefined) {
    // "^}" means a line starting with "}": the end of a top-level block, not any brace.
    const until = range.until;
    const ends = until.startsWith("^")
      ? (line: string) => line.startsWith(until.slice(1))
      : (line: string) => line.includes(until);
    const offset = all.slice(start - 1).findIndex(ends);
    if (offset === -1) {
      throw new Error(
        `Guide : fin ${JSON.stringify(range.until)} introuvable dans ${path} après la ligne ${start}.`,
      );
    }
    end = start + offset;
  }
  const picked = all.slice(start - 1, Math.min(end, all.length));
  const indent = Math.min(
    ...picked.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length),
  );
  return { code: picked.map((line) => line.slice(indent)).join("\n"), start, end };
}

/** The whole file, for short files shown in full. */
export function whole(path: string): string {
  return lines(path).join("\n").trimEnd();
}
