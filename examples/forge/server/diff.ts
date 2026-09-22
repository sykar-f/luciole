import type { DiffRow } from "../components/model";

const CONTEXT = 3;
type Op = { kind: "context" | "add" | "delete"; text: string };

// Line LCS after trimming the common prefix and suffix. Quadratic only on the changed
// middle, which stays small for review-sized edits.
function operations(before: string[], after: string[]): Op[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length,
    endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  const a = before.slice(start, endBefore),
    b = after.slice(start, endAfter);
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const middle: Op[] = [];
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      middle.push({ kind: "context", text: a[i] });
      i++;
      j++;
    } else if (i < a.length && (j === b.length || table[i + 1][j] >= table[i][j + 1])) {
      // Deletions first, like git.
      middle.push({ kind: "delete", text: a[i++] });
    } else middle.push({ kind: "add", text: b[j++] });
  }
  return [
    ...before.slice(0, start).map((text) => ({ kind: "context" as const, text })),
    ...middle,
    ...before.slice(endBefore).map((text) => ({ kind: "context" as const, text })),
  ];
}

const lines = (text: string) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));
const sign = { context: " ", add: "+", delete: "-" } as const;

/** Unified patch with three lines of context, as `git diff` prints it. */
export function unifiedDiff(path: string, before: string, after: string): string {
  const ops = operations(lines(before), lines(after));
  const changed = ops
    .map((op, index) => (op.kind === "context" ? -1 : index))
    .filter((i) => i >= 0);
  if (!changed.length) return "";
  const hunks: [number, number][] = [];
  for (const index of changed) {
    const from = Math.max(0, index - CONTEXT),
      to = Math.min(ops.length - 1, index + CONTEXT);
    const last = hunks.at(-1);
    if (last && from <= last[1] + 1) last[1] = to;
    else hunks.push([from, to]);
  }
  const out = [`--- a/${path}`, `+++ b/${path}`];
  for (const [from, to] of hunks) {
    let oldLine = 1,
      newLine = 1;
    for (const op of ops.slice(0, from)) {
      if (op.kind !== "add") oldLine++;
      if (op.kind !== "delete") newLine++;
    }
    const body = ops.slice(from, to + 1);
    const oldCount = body.filter((op) => op.kind !== "add").length,
      newCount = body.filter((op) => op.kind !== "delete").length;
    out.push(
      `@@ -${oldCount ? oldLine : oldLine - 1},${oldCount} +${newCount ? newLine : newLine - 1},${newCount} @@`,
    );
    for (const op of body) out.push(sign[op.kind] + op.text);
  }
  return out.join("\n") + "\n";
}

/** Rows in drawing order: headers and hunk markers are not drawn by the renderable. */
export function diffRows(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0,
    newLine = 0,
    inHunk = false;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith("\\")) continue;
    if (line.startsWith("+")) rows.push({ kind: "add", new: newLine++ });
    else if (line.startsWith("-")) rows.push({ kind: "delete", old: oldLine++ });
    else if (line.startsWith(" ")) rows.push({ kind: "context", old: oldLine++, new: newLine++ });
    else inHunk = false;
  }
  return rows;
}

export function stats(patch: string) {
  const rows = diffRows(patch);
  return {
    additions: rows.filter((r) => r.kind === "add").length,
    deletions: rows.filter((r) => r.kind === "delete").length,
  };
}

const LANGUAGES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  md: "markdown",
  json: "json",
  rs: "rust",
  py: "python",
  toml: "toml",
  yml: "yaml",
  yaml: "yaml",
  css: "css",
  sql: "sql",
};
export function languageOf(path: string) {
  return LANGUAGES[path.split(".").at(-1) ?? ""] ?? "text";
}
