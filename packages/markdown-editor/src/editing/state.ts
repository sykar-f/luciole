import { caret, clampPos, contentOf, isCollapsed, range } from "../model/doc.ts";
import { marksAt } from "../model/inline.ts";
import type { Doc, Marks, Pos, Selection } from "../model/types.ts";

/**
 * Delimiters typed but not yet understood: `*` may open italic, `**` bold, and either may
 * be a plain star. They sit in the text as typed until the next key decides.
 */
export type Pending = {
  readonly char: DelimiterChar;
  readonly count: number;
  /** Where the typed run starts. */
  readonly from: Pos;
  /** The typing marks before the run: what it opens is off there, what it closes is on. */
  readonly base: Marks;
  /** Typed over a selection: the selection's state before the first delimiter. */
  readonly wrap?: EditorState;
};
export type DelimiterChar = "*" | "_" | "~" | "`";

/** Everything an edit reads and writes. Immutable: every command returns a new state. */
export type EditorState = {
  readonly doc: Doc;
  readonly selection: Selection;
  /**
   * The marks text typed next takes, once a delimiter has turned them on or off; null
   * follows the text before the cursor. Moving the cursor or starting a block forgets
   * them: an emphasis opened and left is closed there.
   */
  readonly stored: Marks | null;
  readonly pending: Pending | null;
  /**
   * What the text would be had the last input rule not fired (`# ` stayed `# `, `**`
   * stayed two stars): Backspace right after the rule goes back to it.
   */
  readonly literal: EditorState | null;
};

export function createState(doc: Doc, selection: Selection = caret({ block: 0, offset: 0 })) {
  const state: EditorState = { doc, selection, stored: null, pending: null, literal: null };
  return withSelection(state, selection);
}

/** The state with the cursor elsewhere: stored marks, pending delimiters, rules forgotten. */
export function withSelection(state: EditorState, selection: Selection): EditorState {
  return {
    doc: state.doc,
    selection: {
      anchor: clampPos(state.doc, selection.anchor),
      head: clampPos(state.doc, selection.head),
    },
    stored: null,
    pending: null,
    literal: null,
  };
}

/** A new document and cursor after an edit; what typing carries is the caller's. */
export const withEdit = (
  state: EditorState,
  doc: Doc,
  head: Pos,
  carry: Partial<Pick<EditorState, "stored" | "pending" | "literal">> = {},
): EditorState => ({
  doc,
  selection: caret(clampPos(doc, head)),
  stored: carry.stored ?? null,
  pending: carry.pending ?? null,
  literal: carry.literal ?? null,
});

export const cursor = (state: EditorState) => state.selection.head;
export const selectionRange = (state: EditorState) => range(state.selection);
export const hasSelection = (state: EditorState) => !isCollapsed(state.selection);

/** The marks text typed at the cursor takes. */
export function typingMarks(state: EditorState): Marks {
  if (state.stored) return state.stored;
  const { head } = state.selection;
  const block = state.doc[head.block];
  return block ? marksAt(contentOf(block), head.offset) : {};
}
