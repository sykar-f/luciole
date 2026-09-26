import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

// `@file` completion: the project's files, as git knows them (ignored files left out),
// else a bounded walk. Read once per query: the list is small next to a keystroke's cost.
const MAX_FILES = 20_000;
const MAX_RESULTS = 30;
// Scores: a direct match ranks by position then length; letters in order come after.
const LENGTH_WEIGHT = 100;
const SCATTERED = 1000;
const SKIPPED = new Set([".git", "node_modules", ".airtty", "dist", "build", ".venv", "target"]);

async function gitFiles(cwd: string) {
  const git = Bun.spawn(["git", "ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd,
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(git.stdout).text();
  return (await git.exited) === 0
    ? text.split("\n").filter(Boolean).slice(0, MAX_FILES)
    : undefined;
}

async function walk(cwd: string) {
  const found: string[] = [];
  const visit = async (dir: string) => {
    if (found.length >= MAX_FILES) return;
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (SKIPPED.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (found.length < MAX_FILES) found.push(relative(cwd, path));
    }
  };
  await visit(cwd);
  return found;
}

/** Files whose path contains `query`'s letters in order, the closest first. */
export async function findFiles(cwd: string, query: string) {
  const files = (await gitFiles(cwd).catch(() => undefined)) ?? (await walk(cwd));
  const needle = query.toLowerCase();
  const scored = files.flatMap((file) => {
    const haystack = file.toLowerCase();
    const direct = haystack.indexOf(needle);
    if (direct >= 0) return [{ file, score: direct + file.length / LENGTH_WEIGHT }];
    let at = 0;
    for (const char of needle) {
      at = haystack.indexOf(char, at);
      if (at < 0) return [];
      at++;
    }
    return [{ file, score: SCATTERED + file.length }];
  });
  return scored
    .sort((a, b) => a.score - b.score)
    .slice(0, MAX_RESULTS)
    .map((s) => s.file);
}
