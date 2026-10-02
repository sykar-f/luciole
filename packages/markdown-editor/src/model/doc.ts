import { concat, lengthOf, plain, slice, splice, textOf } from "./inline.ts";
import {
  isLines,
  isText,
  quoteOf,
  type Block,
  type Doc,
  type HeadingLevel,
  type Inline,
  type LinesBlock,
  type Place,
  type Pos,
  type Selection,
  type TextBlock,
} from "./types.ts";

// Structural edits on a document. A block is rebuilt, never mutated, and a rebuilt block
// drops the `source` it was read from: it is written back from its meaning.

const MAX_HEADING = 6;
const isHeadingLevel = (level: number): level is HeadingLevel =>
  Number.isInteger(level) && level >= 1 && level <= MAX_HEADING;
/** A heading level from a count of `#`: deeper than 6 is 6. */
export function headingLevel(depth: number): HeadingLevel {
  const level = Math.max(1, Math.min(MAX_HEADING, Math.trunc(depth)));
  return isHeadingLevel(level) ? level : 1;
}

export const paragraph = (content: Inline = []): TextBlock => ({ type: "paragraph", content });
export const EMPTY_DOC: Doc = [paragraph()];

/** A block's text as the cursor walks it. A rule has none. */
export function contentOf(block: Block): Inline {
  if (isText(block)) return block.content;
  if (isLines(block)) return plain(block.text);
  return [];
}
export const textOfBlock = (block: Block) => textOf(contentOf(block));
export const lengthOfBlock = (block: Block) => lengthOf(contentOf(block));

/** Where `block` sits (its quotes, its list), without the source it was read from. */
export function placeOf(block: Block): Place {
  return {
    ...(block.quote ? { quote: block.quote } : {}),
    ...(block.break ? { break: true } : {}),
    ...(block.type !== "item" && block.depth ? { depth: block.depth } : {}),
  };
}
/** `place` without the `break` that only the first block of a quote has. */
export const goingOn = (place: Place): Place => {
  const { break: _, ...rest } = place;
  return rest;
};

/** `block`'s kind, settings and place around new text. A rule becomes a paragraph. */
export function rebuild(block: Block, content: Inline): Block {
  const place = placeOf(block);
  switch (block.type) {
    case "paragraph":
      return { type: "paragraph", content, ...place };
    case "heading":
      return { type: "heading", level: block.level, content, ...place };
    case "item":
      return {
        type: "item",
        list: block.list,
        indent: block.indent,
        ...(block.list === "task" ? { checked: block.checked === true } : {}),
        ...(block.start === undefined ? {} : { start: block.start }),
        ...(block.marker === undefined ? {} : { marker: block.marker }),
        ...(block.loose ? { loose: true } : {}),
        content,
        ...place,
      };
    case "code":
      return { type: "code", lang: block.lang, text: textOf(content), ...place };
    case "raw":
      return { type: "raw", text: textOf(content), ...place };
    case "rule":
      return { type: "paragraph", content, ...place };
  }
}
export const withText = (block: LinesBlock, text: string): Block => rebuild(block, plain(text));

export const comparePos = (a: Pos, b: Pos) => a.block - b.block || a.offset - b.offset;
export const samePos = (a: Pos, b: Pos) => comparePos(a, b) === 0;
export const caret = (pos: Pos): Selection => ({ anchor: pos, head: pos });
export const isCollapsed = (selection: Selection) => samePos(selection.anchor, selection.head);
/** The selection's two ends in document order. */
export function range(selection: Selection) {
  const forward = comparePos(selection.anchor, selection.head) <= 0;
  return forward
    ? { from: selection.anchor, to: selection.head }
    : { from: selection.head, to: selection.anchor };
}
export function clampPos(doc: Doc, pos: Pos): Pos {
  const block = Math.max(0, Math.min(doc.length - 1, pos.block));
  const length = lengthOfBlock(doc[block] ?? paragraph());
  return { block, offset: Math.max(0, Math.min(length, pos.offset)) };
}
export const docEnd = (doc: Doc): Pos => ({
  block: doc.length - 1,
  offset: lengthOfBlock(doc.at(-1) ?? paragraph()),
});

export type Edit = { doc: Doc; pos: Pos };

const replaceBlocks = (doc: Doc, from: number, to: number, blocks: readonly Block[]): Doc => {
  const next = [...doc.slice(0, from), ...blocks, ...doc.slice(to + 1)];
  return next.length ? next : EMPTY_DOC;
};
export const replaceBlock = (doc: Doc, index: number, block: Block): Doc =>
  replaceBlocks(doc, index, index, [block]);

/**
 * Removes `from`..`to`. Across blocks, the first block keeps its kind and takes the rest
 * of the last one, as in any text editor; a rule at the start goes with the selection.
 */
export function deleteRange(doc: Doc, from: Pos, to: Pos): Edit {
  const first = doc[from.block];
  const last = doc[to.block];
  if (!first || !last) return { doc, pos: from };
  if (from.block === to.block) {
    const block = rebuild(first, splice(contentOf(first), from.offset, to.offset));
    return { doc: replaceBlock(doc, from.block, keepKind(first, block)), pos: from };
  }
  const rest = slice(contentOf(last), to.offset);
  const merged =
    first.type === "rule"
      ? last.type === "rule"
        ? paragraph()
        : rebuild(last, rest)
      : rebuild(first, concat(slice(contentOf(first), 0, from.offset), rest));
  return {
    doc: replaceBlocks(doc, from.block, to.block, [merged]),
    pos: { block: from.block, offset: first.type === "rule" ? 0 : from.offset },
  };
}
/** A rule has no text to cut: deleting inside one leaves it a rule. */
const keepKind = (before: Block, after: Block) => (before.type === "rule" ? before : after);

/**
 * Cuts the block at `pos` in two, the way Return does: the second half is a paragraph
 * after a heading, the next item of a list, the same kind elsewhere.
 */
export function splitBlock(doc: Doc, pos: Pos): Edit {
  const block = doc[pos.block];
  if (!block) return { doc, pos };
  if (block.type === "rule")
    return {
      doc: replaceBlocks(doc, pos.block, pos.block, [
        block,
        { ...paragraph(), ...goingOn(placeOf(block)) },
      ]),
      pos: { block: pos.block + 1, offset: 0 },
    };
  const content = contentOf(block);
  const head = rebuild(block, slice(content, 0, pos.offset));
  const rest = slice(content, pos.offset);
  const tail: Block = {
    ...(block.type === "heading"
      ? { ...paragraph(rest), ...placeOf(block) }
      : block.type === "item"
        ? rebuild({ ...block, checked: false, start: undefined }, rest)
        : rebuild(block, rest)),
    // The second half goes on in the same quote: it does not start one.
    break: undefined,
  };
  return {
    doc: replaceBlocks(doc, pos.block, pos.block, [head, tail]),
    pos: { block: pos.block + 1, offset: 0 },
  };
}

/**
 * Puts `fragment` at `pos`, as pasting does. Its first paragraph flows into the block at
 * `pos`, the text after `pos` goes on at the end of its last block, and every block in
 * between keeps its own kind.
 */
export function insertFragment(doc: Doc, pos: Pos, fragment: Doc): Edit {
  const block = doc[pos.block];
  const first = fragment[0];
  if (!block || !first) return { doc, pos };
  const content = contentOf(block);
  const before = slice(content, 0, pos.offset);
  const after = slice(content, pos.offset);
  const inline = first.type === "paragraph" || (isLines(block) && fragment.length === 1);
  if (fragment.length === 1 && inline && block.type !== "rule") {
    const added = contentOf(first);
    return {
      doc: replaceBlock(doc, pos.block, rebuild(block, concat(before, added, after))),
      pos: { block: pos.block, offset: pos.offset + lengthOf(added) },
    };
  }
  const blocks: Block[] = [];
  let rest = fragment;
  if (first.type === "paragraph" && block.type !== "rule") {
    blocks.push(rebuild(block, concat(before, first.content)));
    rest = fragment.slice(1);
  } else if (block.type === "rule") blocks.push(block);
  else if (lengthOf(before) > 0 || block.type !== "paragraph") blocks.push(rebuild(block, before));
  blocks.push(...rest);
  const last = blocks.at(-1) ?? paragraph();
  const end = lengthOfBlock(last);
  if (lengthOf(after) > 0 && last.type !== "rule")
    blocks[blocks.length - 1] = rebuild(last, concat(contentOf(last), after));
  else if (lengthOf(after) > 0) blocks.push(rebuild(block, after));
  const index = pos.block + blocks.length - (lengthOf(after) > 0 && last.type === "rule" ? 2 : 1);
  return {
    doc: replaceBlocks(doc, pos.block, pos.block, blocks),
    pos: { block: index, offset: last.type === "rule" ? 0 : end },
  };
}

/**
 * The number an ordered item shows: its list's start, plus the items above it. What the
 * items hold (their paragraphs, nested lists) does not interrupt the count.
 */
export function listNumber(doc: Doc, index: number) {
  const item = doc[index];
  if (item?.type !== "item") return 0;
  let number = 1;
  let first = index;
  for (let i = index - 1; i >= 0; i--) {
    const above = doc[i];
    if (!above || quoteOf(above) !== quoteOf(item)) break;
    if (above.type !== "item") {
      if ((above.depth ?? 0) > item.indent) continue;
      break;
    }
    if (above.indent < item.indent) break;
    if (above.indent > item.indent) continue;
    if (above.list !== item.list || above.marker !== item.marker) break;
    number++;
    first = i;
  }
  const head = doc[first];
  const start = head?.type === "item" ? (head.start ?? 1) : 1;
  return start + number - 1;
}

/**
 * Whether `doc[index]` goes on the line right after the block above, with no blank line
 * between: inside a tight list. Markdown is written so, and the screen draws it so.
 */
export function joins(doc: Doc, index: number): boolean {
  const previous = doc[index - 1];
  const block = doc[index];
  if (!previous || !block || quoteOf(previous) !== quoteOf(block) || block.break) return false;
  if (block.type === "item") {
    // A list's first item sits under its parent's text, a blank line away only when the
    // parent's list is loose (a blank line there would loosen it).
    if (previous.type === "item" && block.indent > previous.indent) return !previous.loose;
    // Inside a list, items and what they hold touch unless the list is loose.
    return (previous.type === "item" || (previous.depth ?? 0) > 0) && !block.loose;
  }
  const depth = block.depth ?? 0;
  if (depth === 0) return false;
  // The text of an item that has none yet starts on the line after its marker.
  if (previous.type === "item" && previous.indent === depth - 1 && !previous.content.length)
    return true;
  // What a loose list's item holds is a blank line apart, as its items are.
  if (parentOf(doc, index)?.loose) return false;
  // A paragraph right under text would join it; a rule under text would underline it.
  const underText = previous.type === "paragraph" || previous.type === "item";
  return (
    !underText || (block.type !== "paragraph" && block.type !== "rule" && block.type !== "raw")
  );
}

/** The item a block other than an item goes on: the last one above at the level it is in. */
export function parentOf(doc: Doc, index: number) {
  const block = doc[index];
  const depth = block && block.type !== "item" ? (block.depth ?? 0) : 0;
  if (!block || depth === 0) return undefined;
  for (let i = index - 1; i >= 0; i--) {
    const above = doc[i];
    if (!above || quoteOf(above) !== quoteOf(block)) return undefined;
    if (above.type === "item" && above.indent === depth - 1) return above;
    if (above.type === "item" && above.indent < depth - 1) return undefined;
  }
  return undefined;
}
