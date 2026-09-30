import type { Doc, Selection } from "../model/types.ts";

// Undo and redo as snapshots: a document is immutable, so a snapshot is a reference.
// Typing groups: a burst of characters is one step, closed by a pause, a space after a
// word, or any other kind of edit.

export type Snapshot = { readonly doc: Doc; readonly selection: Selection };
/** What an edit was, for grouping: typed characters join, anything else stands alone. */
export type EditKind = "type" | "delete" | "other";

export type History = {
  readonly past: readonly Snapshot[];
  readonly future: readonly Snapshot[];
  readonly last: { kind: EditKind; at: number; word: boolean } | null;
};

const GROUP_MS = 800;
const DEPTH = 500;

export const emptyHistory: History = { past: [], future: [], last: null };

/**
 * `before` recorded as the state an edit of `kind` left. `text` is what was typed, for
 * grouping: a burst of word characters is one step, and so is its following space.
 */
export function record(
  history: History,
  before: Snapshot,
  kind: EditKind,
  options: { now: number; text?: string },
): History {
  const word = options.text !== undefined && /\S/.test(options.text);
  const last = history.last;
  const joins =
    last !== null &&
    kind !== "other" &&
    last.kind === kind &&
    options.now - last.at < GROUP_MS &&
    // A new word after a space starts a new step.
    !(kind === "type" && word && !last.word);
  const next = { kind, at: options.now, word };
  if (joins) return { past: history.past, future: [], last: next };
  return { past: [...history.past, before].slice(-DEPTH), future: [], last: next };
}

export function undo(history: History, current: Snapshot) {
  const previous = history.past.at(-1);
  if (!previous) return null;
  return {
    history: { past: history.past.slice(0, -1), future: [current, ...history.future], last: null },
    snapshot: previous,
  };
}

export function redo(history: History, current: Snapshot) {
  const next = history.future[0];
  if (!next) return null;
  return {
    history: { past: [...history.past, current], future: history.future.slice(1), last: null },
    snapshot: next,
  };
}
