import {
  caret,
  contentOf,
  deleteRange,
  docEnd,
  insertFragment,
  lengthOfBlock,
  paragraph,
  placeOf,
  rebuild,
  replaceBlock,
  splitBlock as split,
  textOfBlock,
} from "../model/doc.ts";
import {
  cleanMarks,
  concat,
  hasMark,
  linkAround,
  plain,
  setMark,
  slice,
  splice,
  textOf,
  withMark,
} from "../model/inline.ts";
import { parseMarkdown } from "../markdown/parse.ts";
import { nextBoundary, previousBoundary, wordAround, wordEnd, wordStart } from "../model/text.ts";
import {
  isLines,
  isText,
  quoteOf,
  type Block,
  type Doc,
  type HeadingLevel,
  type ListKind,
  type Marks,
  type MarkName,
  type Pos,
} from "../model/types.ts";
import {
  cursor,
  hasSelection,
  selectionRange,
  typingMarks,
  withEdit,
  withSelection,
  type EditorState,
} from "./state.ts";

// The edits themselves, without the input rules: what a menu, a toolbar or a key binding
// asks for. Each takes a state and returns the next one.

/** The selection's text removed; the cursor where it started. */
export function deleteSelection(state: EditorState): EditorState {
  if (!hasSelection(state)) return state;
  const { from, to } = selectionRange(state);
  const edit = deleteRange(state.doc, from, to);
  return withEdit(state, edit.doc, edit.pos);
}

/** `text` at the cursor, in `marks` (the typing marks by default), replacing the selection. */
export function insertText(state: EditorState, text: string, marks?: Marks): EditorState {
  const typed = marks ?? typingMarks(state);
  const base = deleteSelection(state);
  const at = cursor(base);
  const block = base.doc[at.block];
  if (!block || !text) return base;
  if (block.type === "rule") {
    // Typing on a rule starts a paragraph below it.
    const doc = [
      ...base.doc.slice(0, at.block + 1),
      paragraph(plain(text, typed)),
      ...base.doc.slice(at.block + 1),
    ];
    return withEdit(
      base,
      doc,
      { block: at.block + 1, offset: text.length },
      { stored: state.stored },
    );
  }
  const added = isLines(block) ? plain(text) : plain(text, typed);
  const next = rebuild(block, splice(contentOf(block), at.offset, at.offset, added));
  return withEdit(
    base,
    replaceBlock(base.doc, at.block, next),
    { block: at.block, offset: at.offset + text.length },
    { stored: state.stored },
  );
}

/** Backspace without rules: the selection, the character before, or the join with the block above. */
export function deleteBackward(state: EditorState): EditorState {
  if (hasSelection(state)) return deleteSelection(state);
  const at = cursor(state);
  const block = state.doc[at.block];
  if (!block) return state;
  if (at.offset > 0) {
    const from = previousBoundary(textOfBlock(block), at.offset);
    const edit = deleteRange(state.doc, { block: at.block, offset: from }, at);
    return withEdit(state, edit.doc, edit.pos);
  }
  const above = state.doc[at.block - 1];
  if (!above) return state;
  if (above.type === "rule") {
    const doc = state.doc.filter((_, i) => i !== at.block - 1);
    return withEdit(state, doc, { block: at.block - 1, offset: 0 });
  }
  const end = { block: at.block - 1, offset: lengthOfBlock(above) };
  if (apart(above, block)) return meet(state, at.block - 1, at.block, end);
  const edit = deleteRange(state.doc, end, at);
  return withEdit(state, edit.doc, edit.pos);
}

/**
 * Whether two neighbours must not be joined into one: text and code, text and a table (a
 * table's Markdown in a paragraph, a paragraph's words in a table's rows break both).
 */
const apart = (a: Block, b: Block) =>
  isLines(a) !== isLines(b) || (isLines(a) && isLines(b) && a.type !== b.type);
/**
 * Backspace or Delete between two blocks that stay apart: an empty one goes, otherwise the
 * cursor only crosses to `crossed`.
 */
function meet(state: EditorState, first: number, second: number, crossed: Pos): EditorState {
  const a = state.doc[first];
  const b = state.doc[second];
  if (b && !lengthOfBlock(b) && state.doc.length > 1) {
    const doc = state.doc.filter((_, i) => i !== second);
    const end = { block: first, offset: a ? lengthOfBlock(a) : 0 };
    return withEdit(state, doc, end);
  }
  if (a && !lengthOfBlock(a)) {
    const doc = state.doc.filter((_, i) => i !== first);
    return withEdit(state, doc, { block: first, offset: 0 });
  }
  return withEdit(state, state.doc, crossed);
}

/** Delete: the selection, the character after, or the join with the block below. */
export function deleteForward(state: EditorState): EditorState {
  if (hasSelection(state)) return deleteSelection(state);
  const at = cursor(state);
  const block = state.doc[at.block];
  if (!block) return state;
  const length = lengthOfBlock(block);
  if (at.offset < length) {
    const to = nextBoundary(textOfBlock(block), at.offset);
    const edit = deleteRange(state.doc, at, { block: at.block, offset: to });
    return withEdit(state, edit.doc, edit.pos);
  }
  const below = state.doc[at.block + 1];
  if (!below) return state;
  if (block.type === "rule") {
    const doc = state.doc.filter((_, i) => i !== at.block);
    return withEdit(state, doc, { block: at.block, offset: 0 });
  }
  if (apart(block, below))
    return meet(state, at.block, at.block + 1, { block: at.block + 1, offset: 0 });
  const edit = deleteRange(state.doc, at, { block: at.block + 1, offset: 0 });
  return withEdit(state, edit.doc, edit.pos);
}

/** The word before the cursor (Alt+Backspace, Ctrl+W). */
export function deleteWordBackward(state: EditorState): EditorState {
  if (hasSelection(state)) return deleteSelection(state);
  const at = cursor(state);
  const block = state.doc[at.block];
  if (!block || at.offset === 0) return deleteBackward(state);
  const from = wordStart(textOfBlock(block), at.offset);
  const edit = deleteRange(state.doc, { block: at.block, offset: from }, at);
  return withEdit(state, edit.doc, edit.pos);
}
/** The word after the cursor (Alt+Delete). */
export function deleteWordForward(state: EditorState): EditorState {
  if (hasSelection(state)) return deleteSelection(state);
  const at = cursor(state);
  const block = state.doc[at.block];
  if (!block || at.offset >= lengthOfBlock(block)) return deleteForward(state);
  const to = wordEnd(textOfBlock(block), at.offset);
  const edit = deleteRange(state.doc, at, { block: at.block, offset: to });
  return withEdit(state, edit.doc, edit.pos);
}

/** Return without rules: the block cut in two at the cursor. */
export function splitBlock(state: EditorState): EditorState {
  const base = deleteSelection(state);
  const edit = split(base.doc, cursor(base));
  return withEdit(base, edit.doc, edit.pos);
}

/** A line break inside the block (Shift+Return); a heading, one line, is cut instead. */
export function insertLineBreak(state: EditorState): EditorState {
  const block = state.doc[cursor(state).block];
  if (!block || block.type === "heading" || block.type === "rule") return splitBlock(state);
  return insertText(state, "\n");
}

/** Markdown pasted at the cursor: its blocks and marks, as if typed in this editor. */
export function insertMarkdown(state: EditorState, markdown: string): EditorState {
  const base = deleteSelection(state);
  const at = cursor(base);
  const block = base.doc[at.block];
  if (!block) return base;
  if (isLines(block)) return insertText(base, markdown);
  const fragment = parseMarkdown(markdown.replace(/\r\n?/g, "\n")).map(withoutSource);
  const edit = insertFragment(base.doc, at, fragment);
  return withEdit(base, edit.doc, edit.pos);
}
/** Pasted blocks are new to this document: none is written back as read. */
const withoutSource = (block: Block): Block =>
  block.type === "item" ? block : rebuild(block, contentOf(block));

export function selectAll(state: EditorState): EditorState {
  return withSelection(state, { anchor: { block: 0, offset: 0 }, head: docEnd(state.doc) });
}

/** The blocks the selection touches, `fn` applied to each. */
function mapSelectedBlocks(
  state: EditorState,
  fn: (block: Block, index: number) => Block,
): EditorState {
  const { from, to } = selectionRange(state);
  const doc: Doc = state.doc.map((block, index) =>
    index >= from.block && index <= to.block ? fn(block, index) : block,
  );
  return { ...state, doc, literal: null, pending: null };
}

/** Bold, italic, strike or code, on the selection, or for the text typed next. */
export function toggleMark(state: EditorState, mark: MarkName): EditorState {
  if (!hasSelection(state)) {
    const marks = typingMarks(state);
    return {
      ...state,
      stored: withMark(marks, mark, marks[mark] !== true),
      pending: null,
      literal: null,
    };
  }
  const { from, to } = selectionRange(state);
  const blocks = state.doc.slice(from.block, to.block + 1);
  const on = !blocks.every((block, i) => {
    if (!isText(block)) return true;
    const start = i === 0 ? from.offset : 0;
    const end = from.block + i === to.block ? to.offset : lengthOfBlock(block);
    return start === end || hasMark(block.content, start, end, mark);
  });
  return mapSelectedBlocks(state, (block, index) => {
    if (!isText(block)) return block;
    const start = index === from.block ? from.offset : 0;
    const end = index === to.block ? to.offset : lengthOfBlock(block);
    return rebuild(block, setMark(block.content, start, end, mark, on));
  });
}

/** What a block can be turned into from a menu or a key. */
export type BlockKind =
  | { type: "paragraph" }
  | { type: "heading"; level: HeadingLevel }
  | { type: "quote" }
  | { type: "item"; list: ListKind }
  | { type: "code" };

/** Turns the selected blocks into `kind`; turning a block into its own kind makes it a paragraph. */
export function setBlockKind(state: EditorState, kind: BlockKind): EditorState {
  const current = state.doc[cursor(state).block];
  const same = current !== undefined && isKind(current, kind);
  return mapSelectedBlocks(state, (block): Block => {
    // A quote is where a block sits, not what it is: it is added or taken away.
    if (kind.type === "quote")
      return { ...rebuild(block, contentOf(block)), quote: same ? undefined : 1 };
    if (block.type === "rule") return block;
    const content = contentOf(block);
    const place = placeOf(block);
    const target: BlockKind = same ? { type: "paragraph" } : kind;
    switch (target.type) {
      case "paragraph":
        return { ...paragraph(isLines(block) ? plain(textOf(content)) : content), ...place };
      case "heading":
        return {
          type: "heading",
          level: target.level,
          content: plain(textOf(content).replaceAll("\n", " ")),
          ...place,
        };
      case "item":
        return {
          type: "item",
          list: target.list,
          indent: block.type === "item" ? block.indent : (block.depth ?? 0),
          ...(target.list === "task" ? { checked: false } : {}),
          content,
          ...place,
          depth: undefined,
        };
      case "code":
        return { type: "code", lang: "", text: textOf(content), ...place };
    }
  });
}
function isKind(block: Block, kind: BlockKind) {
  if (kind.type === "quote") return quoteOf(block) > 0;
  if (block.type !== kind.type) return false;
  if (block.type === "heading" && kind.type === "heading") return block.level === kind.level;
  if (block.type === "item" && kind.type === "item") return block.list === kind.list;
  return true;
}

/** Items of the selection one level deeper (`delta` 1) or shallower (-1). */
export function indentItems(state: EditorState, delta: 1 | -1): EditorState {
  let changed = false;
  const next = mapSelectedBlocks(state, (block, index) => {
    if (block.type !== "item") return block;
    const above = state.doc[index - 1];
    const deepest = above?.type === "item" ? above.indent + 1 : 0;
    const indent = Math.max(0, Math.min(deepest, block.indent + delta));
    if (indent === block.indent) return block;
    changed = true;
    return { ...block, indent };
  });
  return changed ? next : state;
}

/** A task ticked or unticked; a click on its box does it without moving the cursor. */
export function toggleTask(state: EditorState, index: number): EditorState {
  const block = state.doc[index];
  if (block?.type !== "item" || block.list !== "task") return state;
  return {
    ...state,
    doc: replaceBlock(state.doc, index, { ...block, checked: !block.checked }),
    literal: null,
    pending: null,
  };
}

/** The cursor moved to `head`; with `extend`, the selection stretched to it. */
export function moveTo(state: EditorState, head: Pos, options: { extend?: boolean } = {}) {
  return withSelection(
    state,
    options.extend ? { anchor: state.selection.anchor, head } : caret(head),
  );
}

/**
 * A link written out, to be made or changed the way one is typed. Selected text (or the word
 * at the cursor) gets `[` before it and `](` after, the cursor where the address goes; a
 * link at the cursor becomes `[text](address`, the cursor at its end, where Backspace edits
 * the address. Typing `)` makes it a link again.
 */
export function editLink(state: EditorState): EditorState {
  const base = { ...state, pending: null };
  const { from, to } = selectionRange(base);
  const block = base.doc[from.block];
  if (!block || !isText(block) || from.block !== to.block) return state;
  const { content } = block;
  const at = cursor(base);
  const link = hasSelection(base)
    ? null
    : (linkAround(content, at.offset) ?? (at.offset ? linkAround(content, at.offset - 1) : null));
  let start: number;
  let end: number;
  let tail: string;
  if (link) {
    ({ from: start, to: end } = link);
    tail = `](${link.href}`;
  } else {
    const word = hasSelection(base)
      ? { from: from.offset, to: to.offset }
      : wordAround(textOf(content), at.offset);
    ({ from: start, to: end } = word);
    tail = "](";
  }
  const label = slice(content, start, end).map((span) => ({
    text: span.text,
    marks: cleanMarks({ ...span.marks, link: undefined }),
  }));
  const written = concat(plain("["), label, plain(tail));
  const next = rebuild(block, splice(content, start, end, written));
  const pos = { block: from.block, offset: start + textOf(written).length };
  const edited = withEdit(base, replaceBlock(base.doc, from.block, next), pos);
  // A link being made is taken back by Backspace right away; one reopened is edited by it.
  return link ? edited : { ...edited, literal: state };
}
