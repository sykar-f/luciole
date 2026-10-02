import {
  contentOf,
  headingLevel,
  deleteRange,
  insertFragment,
  goingOn,
  paragraph,
  placeOf,
  rebuild,
  replaceBlock,
  textOfBlock,
} from "../model/doc.ts";
import {
  lengthOf,
  marksAt,
  plain as plainText,
  setLink,
  setMark,
  slice,
  splice,
  spanAt,
  withMark,
} from "../model/inline.ts";
import { splitReferences } from "../model/entities.ts";
import { graphemes, isWordChar } from "../model/text.ts";
import { serializeInline, serializeMarkdown } from "../markdown/serialize.ts";
import {
  isLines,
  isText,
  quoteOf,
  type Block,
  type Inline,
  type MarkName,
  type Marks,
} from "../model/types.ts";
import {
  deleteBackward,
  deleteSelection,
  indentItems,
  insertText,
  splitBlock,
} from "./commands.ts";
import {
  cursor,
  hasSelection,
  selectionRange,
  typingMarks,
  withEdit,
  type DelimiterChar,
  type EditorState,
} from "./state.ts";

// Markdown typed as Markdown, shown as its meaning. Three kinds of rules:
//
// - Delimiters (`*`, `_`, `**`, `~~`, `` ` ``) are understood by the key after them: before
//   a word they open, after one they close, before a space they stay characters. What they
//   open is closed without being typed: at the end of the block, or when the cursor leaves.
// - Block markers (`# `, `- `, `1. `, `[ ] `, `> `, then Return after ```` ``` ```` or
//   `---`) turn the block into what they mark.
// - Links: `[text](url)` becomes linked text on its `)`, a URL becomes a link on the space
//   after it.
//
// Every rule keeps the text as typed in `literal`: Backspace right after a rule undoes it
// and leaves the characters, the way a typed `**` stays two stars once taken back.

const DELIMITERS: ReadonlySet<string> = new Set<DelimiterChar>(["*", "_", "~", "`"]);
const isDelimiter = (char: string): char is DelimiterChar => DELIMITERS.has(char);
const isSpace = (char: string) => /^\s$/.test(char);

/** Typed text, key by key, through the rules. */
export function typeText(state: EditorState, text: string): EditorState {
  let next = state;
  for (const { text: char } of graphemes(text)) next = typeChar(next, char);
  return next;
}

function typeChar(state: EditorState, char: string): EditorState {
  const { pending } = state;
  if (pending) {
    if (char === pending.char) return extendPending(state);
    const resolved = resolve(state, char);
    if (resolved === null) return typeChar({ ...state, pending: null }, char);
    const typed = typeChar(resolved, char);
    return { ...typed, literal: insertText({ ...state, pending: null }, char) };
  }
  // A backslash makes the punctuation after it itself: never a marker, written escaped.
  const escaped = ASCII_PUNCTUATION.test(char) ? escapeBefore(state) : null;
  if (escaped) return insertText(escaped, char, { ...typingMarks(escaped), escaped: true });
  if (isDelimiter(char) && takesDelimiters(state, char)) return startPending(state, char);
  const typed = insertText(state, char);
  if (hasSelection(state)) return typed;
  return blockRule(typed, char) ?? inlineRule(typed, char) ?? typed;
}
const ASCII_PUNCTUATION = /^[!-/:-@[-`{-~]$/;

/** Delimiters mean something in text blocks, outside code (except the backtick that ends it). */
function takesDelimiters(state: EditorState, char: DelimiterChar) {
  const block = state.doc[cursor(state).block];
  if (!block || !isText(block)) return false;
  const marks = typingMarks(state);
  return !marks.verbatim && (!marks.code || char === "`");
}

/** The state without the plain backslash right before the cursor, if there is one. */
function escapeBefore(state: EditorState): EditorState | null {
  if (hasSelection(state)) return null;
  const at = cursor(state);
  const block = state.doc[at.block];
  if (!block || !isText(block) || at.offset === 0) return null;
  if (textOfBlock(block)[at.offset - 1] !== "\\" || !plain(block.content, at.offset - 1, at.offset))
    return null;
  const edit = deleteRange(state.doc, { block: at.block, offset: at.offset - 1 }, at);
  return withEdit(state, edit.doc, edit.pos, { stored: state.stored });
}

/** The marks a run of `count` delimiters toggles; none when it is only characters. */
function marksOf(char: DelimiterChar, count: number, wrap: boolean): MarkName[] {
  const STRONG = 2;
  const BOTH = 3;
  switch (char) {
    case "*":
    case "_":
      return count === 1
        ? ["italic"]
        : count === STRONG
          ? ["bold"]
          : count === BOTH
            ? ["bold", "italic"]
            : [];
    case "~":
      return count === STRONG || (wrap && count === 1) ? ["strike"] : [];
    case "`":
      // Two or more are a fence being typed, or code the user wants to write as is.
      return count === 1 ? ["code"] : [];
  }
}

function startPending(state: EditorState, char: DelimiterChar): EditorState {
  if (hasSelection(state)) {
    const wrapped = wrapSelection(state, marksOf(char, 1, true));
    const { from } = selectionRange(state);
    return { ...wrapped, pending: { char, count: 1, from, base: {}, wrap: state } };
  }
  const base = typingMarks(state);
  const typed = insertText(state, char);
  return eagerly({ ...typed, pending: { char, count: 1, from: cursor(state), base } });
}

/**
 * A run that closes what is open, and that one more delimiter could not make mean more,
 * closes at once: `**bold**` shows bold as its last star is typed, with nothing left to
 * wait for.
 */
function eagerly(state: EditorState): EditorState {
  const pending = state.pending;
  if (!pending || pending.wrap) return state;
  const closes = (count: number) => {
    const marks = marksOf(pending.char, count, false);
    return marks.length > 0 && marks.every((mark) => pending.base[mark] === true);
  };
  if (!closes(pending.count) || closes(pending.count + 1)) return state;
  const resolved = resolve(state, null);
  return resolved ? { ...resolved, literal: { ...state, pending: null } } : state;
}

function extendPending(state: EditorState): EditorState {
  const pending = state.pending;
  if (!pending) return state;
  const count = pending.count + 1;
  if (pending.wrap) {
    const wrapped = wrapSelection(pending.wrap, marksOf(pending.char, count, true));
    return { ...wrapped, pending: { ...pending, count } };
  }
  const typed = insertText({ ...state, pending: null }, pending.char);
  return eagerly({ ...typed, pending: { ...pending, count } });
}

/** The selection with each of `marks` toggled over it; the selection stays. */
function wrapSelection(state: EditorState, marks: readonly MarkName[]): EditorState {
  const { from, to } = selectionRange(state);
  const doc = state.doc.map((block, index) => {
    if (index < from.block || index > to.block || !isText(block)) return block;
    const start = index === from.block ? from.offset : 0;
    const end = index === to.block ? to.offset : lengthOf(block.content);
    let content = block.content;
    for (const mark of marks) {
      const on = !slice(content, start, end).every((span) => span.marks[mark] === true);
      content = setMark(content, start, end, mark, on);
    }
    return rebuild(block, content);
  });
  return { ...state, doc, pending: null, literal: null };
}

/**
 * What the pending delimiters become now that `next` follows them (null at a boundary:
 * Return, a click). Null when they stay characters; otherwise the state with them gone and
 * their marks toggled for the text typed next.
 */
function resolve(state: EditorState, next: string | null): EditorState | null {
  const pending = state.pending;
  if (!pending) return null;
  if (pending.wrap) return { ...state, pending: null };
  const marks = marksOf(pending.char, pending.count, false);
  if (!marks.length) return null;
  const closing = marks.every((mark) => pending.base[mark] === true);
  const boundary = next === null || isSpace(next);
  if (boundary && !closing) return null;
  // Right after a word, an opening run is a character: `snake_case`, `2*3=6`, `x**2`.
  if (!closing && wordBefore(state)) return null;
  let stored: Marks = pending.base;
  for (const mark of marks) stored = withMark(stored, mark, stored[mark] !== true);
  const edit = deleteRange(state.doc, pending.from, {
    block: pending.from.block,
    offset: pending.from.offset + pending.count,
  });
  return withEdit(state, edit.doc, edit.pos, { stored });
}
/** Whether a word character is right before the pending run. */
function wordBefore(state: EditorState) {
  const pending = state.pending;
  const block = pending && state.doc[pending.from.block];
  if (!pending || !block || pending.from.offset === 0) return false;
  return isWordChar(textOfBlock(block)[pending.from.offset - 1] ?? "");
}

/**
 * Pending delimiters settled where typing stops (Return, a move): a closing one closes and
 * disappears, any other stays as typed.
 */
export function settle(state: EditorState): EditorState {
  if (!state.pending) return state;
  const resolved = resolve(state, null);
  return resolved
    ? { ...resolved, literal: { ...state, pending: null } }
    : { ...state, pending: null };
}

const HEADING = /^(#{1,6})$/;
const BULLET = /^[-*+]$/;
const ORDERED = /^(\d{1,9})([.)])$/;
const TASK = /^\[([ xX]?)\]$/;
const QUOTE = /^>$/;

/** A block marker at the start of a paragraph, completed by the space just typed. */
function blockRule(typed: EditorState, char: string): EditorState | null {
  if (char !== " ") return null;
  const at = cursor(typed);
  const block = typed.doc[at.block];
  if (!block || (block.type !== "paragraph" && block.type !== "item" && block.type !== "heading"))
    return null;
  const marker = textOfBlock(block).slice(0, at.offset - 1);
  // A marker typed escaped, or in code, is text.
  if (!marker || !plain(block.content, 0, marker.length)) return null;
  const rest = slice(block.content, at.offset);
  const next = convert(block, marker, rest);
  if (!next) return null;
  return {
    ...withEdit(typed, replaceBlock(typed.doc, at.block, next), { block: at.block, offset: 0 }),
    literal: typed,
  };
}
/**
 * `block` (a paragraph, or an item for `[ ] `) as what `marker` marks, holding `content`,
 * in the same place: a list typed in a quote is in the quote, one typed under an item is
 * nested in it.
 */
function convert(block: Block, marker: string, content: Inline): Block | null {
  const place = placeOf(block);
  const task = TASK.exec(marker);
  const checked = task?.[1] === "x" || task?.[1] === "X";
  if (block.type === "item") {
    if (task && block.list === "bullet") return { ...block, content, list: "task", checked };
    // Another list's marker at the start of an item makes it that list's.
    const numbered = ORDERED.exec(marker);
    if (numbered && block.list !== "ordered") {
      const { checked: _, start: __, ...rest } = block;
      const start = Number(numbered[1]);
      return {
        ...rest,
        content,
        list: "ordered",
        marker: numbered[2] === ")" ? ")" : ".",
        ...(start === 1 ? {} : { start }),
      };
    }
    if (BULLET.test(marker) && block.list !== "bullet") {
      const { checked: _, start: __, ...rest } = block;
      return {
        ...rest,
        content,
        list: "bullet",
        marker: marker === "*" ? "*" : marker === "+" ? "+" : "-",
      };
    }
    return null;
  }
  // `## ` at the start of a heading gives it that level.
  const level = HEADING.exec(marker);
  if (block.type === "heading" && level)
    return { ...block, content, level: headingLevel(level[1]?.length ?? 1) };
  if (block.type !== "paragraph") return null;
  const list = { indent: block.depth ?? 0, ...place, depth: undefined };
  const heading = HEADING.exec(marker);
  if (heading)
    return { type: "heading", level: headingLevel(heading[1]?.length ?? 1), content, ...place };
  if (BULLET.test(marker)) return { type: "item", list: "bullet", content, ...list };
  const ordered = ORDERED.exec(marker);
  if (ordered) {
    const start = Number(ordered[1]);
    return {
      type: "item",
      list: "ordered",
      ...(start === 1 ? {} : { start }),
      ...(ordered[2] === ")" ? { marker: ")" } : {}),
      content,
      ...list,
    };
  }
  if (task) return { type: "item", list: "task", checked, content, ...list };
  if (QUOTE.test(marker))
    return { type: "paragraph", content, ...place, quote: quoteOf(block) + 1 };
  return null;
}

const LINK = /\[([^\]\n]+)\]\(([^()\s]+)\)$/;
const IMAGE = /!\[([^\]\n]*)\]\(([^()\s]+)\)$/;
const AUTOLINK = /<((?:https?|ftp|mailto):[^\s<>]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)>$/;
const REFERENCE = /&(?:#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});$/;
const URL_BEFORE = /(https?:\/\/[^\s]+)$/;
// `$…$` just closed: no space inside the dollars, not after a word (`US$5`).
const MATH = /(?:^|[^\w$\\])(\$(?![\s$])[^$\n]*?[^\s$\\]\$|\$[^\s$]\$)$/;

/** Whether `from`..`to` is plain text: nothing escaped, no code, nothing kept as written. */
function plain(content: Inline, from: number, to: number) {
  return slice(content, from, to).every(
    (span) => !span.marks.escaped && !span.marks.code && !span.marks.verbatim,
  );
}

/**
 * Inline Markdown completed by the character just typed: `[text](url)` and `![alt](src)`
 * on their `)`, `<url>` on its `>`, `&copy;` on its `;`, a bare URL on the space after it.
 */
function inlineRule(typed: EditorState, char: string): EditorState | null {
  const at = cursor(typed);
  const block = typed.doc[at.block];
  if (!block || !isText(block)) return null;
  const before = textOfBlock(block).slice(0, at.offset);
  const replace = (length: number, inline: Inline, options: { keepStored?: boolean } = {}) => {
    const start = at.offset - length;
    if (!plain(block.content, start, at.offset)) return null;
    const content = splice(block.content, start, at.offset, inline);
    return {
      ...withEdit(
        typed,
        replaceBlock(typed.doc, at.block, rebuild(block, content)),
        { block: at.block, offset: start + lengthOf(inline) },
        options.keepStored ? { stored: typed.stored } : {},
      ),
      literal: typed,
    };
  };
  const marks = marksAt(block.content, Math.max(0, at.offset - 1));
  if (char === ")") {
    // An image is drawn as its Markdown, kept as written.
    const image = IMAGE.exec(before);
    if (image) return replace(image[0].length, [{ text: image[0], marks: { verbatim: true } }]);
    const link = LINK.exec(before);
    const label = link?.[1];
    const href = link?.[2];
    if (!link || label === undefined || href === undefined) return null;
    const start = at.offset - link[0].length;
    const text = slice(block.content, start + 1, start + 1 + label.length);
    return replace(link[0].length, setLink(text, 0, label.length, href));
  }
  if (char === "$") {
    // Math, kept as written: `$x^2$` on its closing dollar.
    const math = MATH.exec(before)?.[1];
    if (math) return replace(math.length, [{ text: math, marks: { verbatim: true } }]);
  }
  if (char === ">") {
    const address = AUTOLINK.exec(before)?.[1];
    if (address === undefined) return null;
    const href = address.includes(":") ? address : `mailto:${address}`;
    return replace(address.length + 2, plainText(address, { ...marks, link: href }));
  }
  if (char === ";") {
    const reference = REFERENCE.exec(before)?.[0];
    const decoded = reference === undefined ? undefined : splitReferences(reference)[0];
    if (reference === undefined || !decoded?.known || decoded.text === reference) return null;
    return replace(reference.length, plainText(decoded.text, marks), { keepStored: true });
  }
  if (!isSpace(char)) return null;
  return autolink(typed, at.offset - 1);
}

/**
 * The bare URL ending at `end` in the cursor's block made a link, as GFM reads one: a
 * trailing `.` or `,` and a `)` it did not open are the sentence's, not the URL's.
 */
function autolink(state: EditorState, end: number): EditorState | null {
  const at = cursor(state);
  const block = state.doc[at.block];
  if (!block || !isText(block)) return null;
  const found = URL_BEFORE.exec(textOfBlock(block).slice(0, end))?.[1];
  if (!found) return null;
  let url = found.replace(TRAILING_PUNCTUATION, "");
  while (url.endsWith(")") && count(url, "(") < count(url, ")")) url = url.slice(0, -1);
  const start = end - found.length;
  const stop = start + url.length;
  if (!url || spanAt(block.content, start)?.span.marks.link !== undefined) return null;
  if (!plain(block.content, start, stop)) return null;
  const content = setLink(block.content, start, stop, url);
  return {
    ...withEdit(state, replaceBlock(state.doc, at.block, rebuild(block, content)), at, {
      stored: state.stored,
    }),
    literal: state,
  };
}
const TRAILING_PUNCTUATION = /[.,;:!?'"*_~]+$/;
const count = (text: string, char: string) => text.split(char).length - 1;

const FENCE = /^(```|~~~)([^`\s]*)$/;
/** Where the TeX goes in a new block of math: after `$$` and its line break. */
const MATH_OPEN = 3;
// A table's delimiter row: `|---|:---:|`, at least one pipe.
const DELIMITER_ROW = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?$|^\|\s*:?-+:?\s*\|?$/;
const RULE = /^(-{3,}|\*{3,}|_{3,})$/;

/** Return: a block marker completed, a list or quote left when empty, code ended, or a split. */
export function enter(state: EditorState): EditorState {
  const cleared = deleteSelection(settle(state));
  // A URL typed last is a link, as when a space follows it.
  const settled = autolink(cleared, cursor(cleared).offset) ?? cleared;
  const at = cursor(settled);
  const block = settled.doc[at.block];
  if (!block) return settled;
  const text = textOfBlock(block);
  const here = goingOn(placeOf(block));
  if (isLines(block)) {
    if (at.offset === text.length && text.endsWith("\n")) {
      const doc = [
        ...settled.doc.slice(0, at.block),
        rebuild(block, contentOf(block).length ? slice(contentOf(block), 0, text.length - 1) : []),
        { ...paragraph(), ...here },
        ...settled.doc.slice(at.block + 1),
      ];
      return withEdit(settled, doc, { block: at.block + 1, offset: 0 });
    }
    return insertText(settled, "\n");
  }
  if (block.type === "paragraph" && at.offset === text.length) {
    // `$$` then Return: a block of math, edited as its TeX between the two `$$`.
    if (text === "$$" && plain(block.content, 0, text.length)) {
      const math: Block = { type: "raw", text: "$$\n\n$$", ...placeOf(block) };
      return {
        ...withEdit(settled, replaceBlock(settled.doc, at.block, math), {
          block: at.block,
          offset: MATH_OPEN,
        }),
        literal: splitBlock(settled),
      };
    }
    const fence = plain(block.content, 0, text.length) ? FENCE.exec(text) : null;
    if (fence) {
      const code: Block = { type: "code", lang: fence[2] ?? "", text: "", ...placeOf(block) };
      return {
        ...withEdit(settled, replaceBlock(settled.doc, at.block, code), {
          block: at.block,
          offset: 0,
        }),
        literal: splitBlock(settled),
      };
    }
    const above = settled.doc[at.block - 1];
    if (
      DELIMITER_ROW.test(text) &&
      text.includes("|") &&
      above?.type === "paragraph" &&
      textOfBlock(above).includes("|") &&
      quoteOf(above) === quoteOf(block)
    ) {
      // A header row, then a delimiter row: a table, edited as its Markdown.
      const table: Block = {
        type: "raw",
        text: `${serializeInline(above.content)}\n${text}\n`,
        ...placeOf(above),
      };
      const doc = [
        ...settled.doc.slice(0, at.block - 1),
        table,
        ...settled.doc.slice(at.block + 1),
      ];
      const end = table.type === "raw" ? table.text.length : 0;
      return {
        ...withEdit(settled, doc, { block: at.block - 1, offset: end }),
        literal: splitBlock(settled),
      };
    }
    if (RULE.test(text) && plain(block.content, 0, text.length)) {
      const edit = insertFragment(
        replaceBlock(settled.doc, at.block, { ...paragraph(), ...placeOf(block) }),
        { block: at.block, offset: 0 },
        [
          { type: "rule", ...placeOf(block) },
          { ...paragraph(), ...here },
        ],
      );
      return {
        ...withEdit(settled, edit.doc, { block: at.block + 1, offset: 0 }),
        literal: splitBlock(settled),
      };
    }
  }
  if ((block.type === "item" || (block.type === "paragraph" && unwrappable(block))) && !text)
    return unwrap(settled, block, at.block);
  if (at.offset === 0 && text && block.type !== "item") {
    // Return at the start of a heading pushes it down instead of emptying it.
    const doc = [
      ...settled.doc.slice(0, at.block),
      { ...paragraph(), ...placeOf(block) },
      ...settled.doc.slice(at.block).map((b, i) => (i === 0 ? { ...b, break: undefined } : b)),
    ];
    return withEdit(settled, doc, { block: at.block + 1, offset: 0 });
  }
  return splitBlock(settled);
}

/**
 * One step out, the way Backspace at a block's start and Return on an empty block go: an
 * item out of its list level (or back to text), a heading back to text, text out of the
 * item it goes on, then out of its quote.
 */
function unwrap(state: EditorState, block: Block, index: number): EditorState {
  if (block.type === "item" && block.indent > 0) return indentItems(state, -1);
  const place = placeOf(block);
  let next: Block;
  if (block.type === "item" || block.type === "heading")
    next = {
      ...paragraph(contentOf(block)),
      ...place,
      depth: block.type === "item" ? block.indent || undefined : place.depth,
    };
  else if (block.depth)
    next = { ...rebuild(block, contentOf(block)), depth: block.depth - 1 || undefined };
  else if (block.quote)
    next = {
      ...rebuild(block, contentOf(block)),
      quote: block.quote - 1 || undefined,
      break: undefined,
    };
  else return state;
  return withEdit(state, replaceBlock(state.doc, index, next), cursor(state));
}
/** Whether a block is marked in a way Backspace at its start takes away. */
const unwrappable = (block: Block) =>
  block.type === "heading" || block.type === "item" || (block.depth ?? 0) > 0 || quoteOf(block) > 0;

/** Backspace: a rule just applied taken back, a block's marker removed, or a deletion. */
export function backspace(state: EditorState): EditorState {
  if (state.literal && !hasSelection(state))
    return { ...state.literal, literal: null, pending: null };
  const base = state.pending ? { ...state, pending: null } : state;
  if (hasSelection(base)) return deleteBackward(base);
  const at = cursor(base);
  const block = base.doc[at.block];
  if (block && at.offset === 0 && unwrappable(block) && !isLines(block))
    return unwrap(base, block, at.block);
  if (block && at.offset === 0 && isLines(block) && !textOfBlock(block))
    return withEdit(base, replaceBlock(base.doc, at.block, paragraph()), at);
  return deleteBackward(base);
}

/**
 * The document as Markdown, pending delimiters settled: what an editor reports while a
 * `*` still waits for its next key is the text it would keep if typing stopped there.
 */
export const toMarkdown = (state: EditorState) => serializeMarkdown(settle(state).doc);
