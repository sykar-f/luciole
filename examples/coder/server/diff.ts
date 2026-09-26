import type { FilePatch } from "../components/model";

// Adapted from examples/forge/server/diff.ts: harnesses give edits as before/after
// strings (Claude's Edit tool, pi's edit) or as patches (Codex, opencode); the transcript
// shows one unified patch per file.
const CONTEXT = 3;
type Op = { kind: "context" | "add" | "delete"; text: string };

// Line LCS after trimming the common prefix and suffix: quadratic only on the changed
// middle, which stays small for an agent's edits.
function operations(before: readonly string[], after: readonly string[]): Op[] {
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
  const at = (i: number, j: number) => table[i]?.[j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) {
      const row = table[i];
      if (row) row[j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  const middle: Op[] = [];
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      middle.push({ kind: "context", text: a[i] ?? "" });
      i++;
      j++;
    } else if (i < a.length && (j === b.length || at(i + 1, j) >= at(i, j + 1))) {
      // Deletions first, like git.
      middle.push({ kind: "delete", text: a[i++] ?? "" });
    } else middle.push({ kind: "add", text: b[j++] ?? "" });
  }
  return [
    ...before.slice(0, start).map((text) => ({ kind: "context" as const, text })),
    ...middle,
    ...before.slice(endBefore).map((text) => ({ kind: "context" as const, text })),
  ];
}

const lines = (text: string) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));
const sign = { context: " ", add: "+", delete: "-" } as const;

/** A unified patch with three lines of context, as `git diff` prints it. */
export function unifiedDiff(path: string, before: string, after: string): string {
  const ops = operations(lines(before), lines(after));
  const changed = ops.flatMap((op, index) => (op.kind === "context" ? [] : [index]));
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

/** Lines added and removed by a patch. */
export function stats(patch: string) {
  let additions = 0,
    deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

/** A file's patch, from before/after contents. */
export function filePatch(path: string, before: string, after: string): FilePatch {
  const patch = unifiedDiff(path, before, after);
  return { path, patch, ...stats(patch) };
}

/**
 * A multi-file unified diff split per file: OpenTUI's `<diff>` shows the first patch
 * only. Files are recognised by their `diff --git` or `---`/`+++` headers.
 */
export function splitPatch(diff: string): FilePatch[] {
  const files: FilePatch[] = [];
  let current: string[] = [];
  const flush = () => {
    const text = current.join("\n");
    const target =
      /^\+\+\+ (?:b\/)?(.+)$/m.exec(text)?.[1] ?? /^--- (?:a\/)?(.+)$/m.exec(text)?.[1];
    if (target && /^@@/m.test(text)) {
      const patch = text.slice(text.indexOf("--- ")).trimEnd() + "\n";
      files.push({ path: target.trim(), patch, ...stats(patch) });
    }
    current = [];
  };
  for (const line of diff.split("\n")) {
    const starts =
      line.startsWith("diff --git ") ||
      (line.startsWith("--- ") && current.some((l) => l.startsWith("@@")));
    if (starts && current.length) flush();
    current.push(line);
  }
  if (current.length) flush();
  return files;
}
