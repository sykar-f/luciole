import type { RGBA } from "@opentui/core";
import { contentOf, joins, listNumber, textOfBlock } from "../model/doc.ts";
import { cellWidth, graphemes } from "../model/text.ts";
import { isLines, quoteOf, type Block, type Doc, type Pos } from "../model/types.ts";
import { groupsByOffset, type Highlights } from "./highlight.ts";
import { HEADING_LEVELS, type Look, type Theme } from "./theme.ts";

// A document laid out for a width: each block's text wrapped into lines of glyphs, and the
// marks that stand for Markdown's markers (bullets, boxes, quote bars, heading bands)
// beside them. Pure: the renderable draws it, and maps cursor and clicks through it.

/** One grapheme on screen: where it is in its block and where it is drawn. */
export type Glyph = {
  readonly text: string;
  readonly offset: number;
  readonly x: number;
  readonly width: number;
  readonly look: Look;
  readonly link?: string;
};
export type Line = {
  /** The block drawn on this line; -1 for the blank lines between blocks. */
  readonly block: number;
  /** The block's text this line shows: `from`..`to`. */
  readonly from: number;
  readonly to: number;
  readonly glyphs: readonly Glyph[];
  /** The column the text starts at, after any marker. */
  readonly textX: number;
  /** The column the block starts at, inside its quotes and list: where panels and bands start. */
  readonly x: number;
  /** How many quote bars stand in the margin. */
  readonly bars: number;
  /** What stands before the text on a block's first line: a bullet, a number, a box. */
  readonly marker?: {
    readonly x: number;
    readonly text: string;
    readonly look: Look;
    readonly task?: boolean;
  };
  /** A background from `x` to the right edge: a code panel. */
  readonly fill?: RGBA;
  /** A heading's band: full from `x` up to `from`, then fading out to the right edge. */
  readonly band?: { readonly color: RGBA; readonly from: number };
  /** A row of a heading's band above or below its title: no text, no cursor. */
  readonly pad?: boolean;
  /** A label at the right end of the line: a code block's language. */
  readonly label?: { readonly text: string; readonly look: Look };
  readonly rule?: boolean;
};
export type Layout = { readonly lines: readonly Line[]; readonly width: number };

const BULLETS = ["•", "◦", "▪"];
const TASK_OPEN = "☐";
const TASK_DONE = "☑";
const LIST_INDENT = 2;
const QUOTE_INDENT = 2;
const CODE_PADDING = 2;
// As luciole's <Markdown> draws headings: the title two columns in, the band full up to a
// column fixed per level (a title typed in never moves it), then fading out to the edge.
const TITLE_INDENT = 2;
const FADE_FROM: Readonly<Record<number, number>> = { 1: 28, 2: 18, 3: 12 };
// Blank lines above a heading of each level, and below it: an H3 sticks to its content.
const ABOVE: Readonly<Record<number, number>> = { 1: 2, 2: 1, 3: 1 };
const BELOW: Readonly<Record<number, number>> = { 1: 1, 2: 1, 3: 0 };

// Blocks are immutable: a block's lines are computed once per theme, width, place and
// highlights, whatever else in the document changes.
type Cached = { readonly lines: readonly Line[]; readonly highlights: Highlights | undefined };
const caches = new WeakMap<Theme, WeakMap<Block, Map<string, Cached>>>();
type BlockContext = {
  /** Where the block starts: an item's marker, any other block's text. */
  readonly x: number;
  readonly number: number;
  readonly width: number;
  readonly theme: Theme;
  readonly highlights: Highlights | undefined;
};

export type LayoutOptions = {
  /** The Tree-sitter highlights of a code block's text, when known. */
  highlight?: (block: number, lang: string, text: string) => Highlights | undefined;
};

const drawnLevel = (block: Block) =>
  block.type === "heading" ? Math.min(block.level, HEADING_LEVELS) : 0;

export function layoutDocument(
  doc: Doc,
  width: number,
  theme: Theme,
  options: LayoutOptions = {},
): Layout {
  const lines: Line[] = [];
  // Where the text of the last item of each list level starts: what it holds lines up there.
  let itemText: number[] = [];
  let lastHeading = 0;
  doc.forEach((block, index) => {
    const previous = doc[index - 1];
    const quote = quoteOf(block);
    if (previous) {
      const shared = Math.min(quoteOf(previous), quote) - (block.break ? 1 : 0);
      for (let i = 0; i < gapBetween(doc, index, lastHeading); i++)
        lines.push({
          block: -1,
          from: 0,
          to: 0,
          glyphs: [],
          textX: 0,
          x: 0,
          bars: Math.max(0, shared),
        });
      if (quoteOf(previous) !== quote) itemText = [];
    }
    const origin = quote * QUOTE_INDENT;
    const level = block.type === "item" ? block.indent : (block.depth ?? 0);
    const x = level > 0 ? (itemText[level - 1] ?? origin + level * LIST_INDENT) : origin;
    const number = block.type === "item" && block.list === "ordered" ? listNumber(doc, index) : 0;
    const highlights =
      block.type === "code" ? options.highlight?.(index, block.lang, block.text) : undefined;
    const placed = blockLines(block, { x, number, width, theme, highlights });
    for (const line of placed) lines.push({ ...line, block: index, bars: quote });
    if (block.type === "item") {
      itemText = [...itemText.slice(0, block.indent), placed[0]?.textX ?? x];
    } else if (level === 0) itemText = [];
    if (block.type === "heading") lastHeading = drawnLevel(block);
  });
  return { lines, width };
}

/**
 * Blank lines above `doc[index]`. Headings keep the reader's rhythm: above them by level
 * (two above an H2 that ends an H3's section), below them by the level above. Elsewhere,
 * as the Markdown is written: none inside a tight list, one between other blocks.
 */
function gapBetween(doc: Doc, index: number, lastHeading: number) {
  const previous = doc[index - 1];
  const block = doc[index];
  if (!previous || !block) return 0;
  const above = drawnLevel(block);
  const below = drawnLevel(previous);
  if (above) {
    const lines = above === 2 && lastHeading === HEADING_LEVELS ? 2 : (ABOVE[above] ?? 1);
    return below ? Math.max(lines, BELOW[below] ?? 1) : lines;
  }
  if (below) return BELOW[below] ?? 1;
  return joins(doc, index) ? 0 : 1;
}

function blockLines(block: Block, context: BlockContext): readonly Line[] {
  const { x, number, width, theme, highlights } = context;
  const key = `${width}:${number}:${x}`;
  let cache = caches.get(theme);
  if (!cache) {
    cache = new WeakMap();
    caches.set(theme, cache);
  }
  let known = cache.get(block);
  const hit = known?.get(key);
  if (hit && hit.highlights === highlights) return hit.lines;
  const lines = computeLines(block, context);
  if (!known) {
    known = new Map();
    cache.set(block, known);
  }
  known.set(key, { lines, highlights });
  return lines;
}

function computeLines(block: Block, context: BlockContext): Line[] {
  const { x, number, width, theme, highlights } = context;
  const at = { x, bars: 0 };
  if (block.type === "rule")
    return [{ block: 0, from: 0, to: 0, glyphs: [], textX: x, ...at, rule: true }];
  const base = theme.blockGroups(block);
  const glyphs = glyphsOf(block, base, theme, highlights);
  if (isLines(block)) {
    const code = block.type === "code";
    const panel = code ? theme.panel() : undefined;
    return wrap(glyphs, code ? x + CODE_PADDING : x, width, { words: false }).map((line, i) => ({
      ...line,
      ...at,
      ...(panel ? { fill: panel } : {}),
      ...(code && i === 0 && block.lang
        ? { label: { text: block.lang, look: theme.label() } }
        : {}),
    }));
  }
  switch (block.type) {
    case "heading": {
      const level = drawnLevel(block);
      const color = theme.band(level);
      if (!color)
        return wrap(glyphs, x, width, { words: true }).map((line) => ({ ...line, ...at }));
      // The title is drawn on the band, which shows through it as it fades.
      const onBand = glyphs.map((g) => ({
        ...g,
        look: { fg: g.look.fg, attributes: g.look.attributes },
      }));
      const band = { color, from: x + (FADE_FROM[level] ?? 0) };
      const title = wrap(onBand, x + TITLE_INDENT, width, { words: true }).map((line) => ({
        ...line,
        ...at,
        band,
      }));
      if (level !== 1) return title;
      // Level 1 is three rows tall, its title in the middle.
      const pad: Line = {
        block: 0,
        from: 0,
        to: 0,
        glyphs: [],
        textX: x + TITLE_INDENT,
        ...at,
        band,
        pad: true,
      };
      return [pad, ...title, pad];
    }
    case "item": {
      const text =
        block.list === "ordered"
          ? `${number}.`
          : block.list === "task"
            ? block.checked
              ? TASK_DONE
              : TASK_OPEN
            : (BULLETS[block.indent % BULLETS.length] ?? "•");
      const look =
        block.list === "task"
          ? theme.marker([block.checked ? "markup.list.checked" : "markup.list.unchecked"])
          : theme.marker();
      const textX = x + text.length + 1;
      const marker = { x, text, look, ...(block.list === "task" ? { task: true } : {}) };
      return wrap(glyphs, textX, width, { words: true }).map((line, i) =>
        i === 0 ? { ...line, ...at, marker } : { ...line, ...at },
      );
    }
    case "paragraph":
      return wrap(glyphs, x, width, { words: true }).map((line) => ({ ...line, ...at }));
  }
}

type Draft = { text: string; offset: number; width: number; look: Look; link?: string };

function glyphsOf(
  block: Block,
  base: readonly string[],
  theme: Theme,
  highlights: Highlights | undefined,
): Draft[] {
  const out: Draft[] = [];
  const code = highlights ? groupsByOffset(highlights, textOfBlock(block).length) : null;
  let offset = 0;
  for (const span of contentOf(block)) {
    const groups = [...base, ...theme.markGroups(span.marks)];
    const look = theme.look(groups);
    for (const g of graphemes(span.text))
      out.push({
        text: g.text,
        offset: offset + g.offset,
        width: g.text === "\n" ? 0 : cellWidth(g.text),
        look: code ? theme.look([...groups, ...(code[offset + g.offset] ?? [])]) : look,
        ...(span.marks.link === undefined ? {} : { link: span.marks.link }),
      });
    offset += span.text.length;
  }
  return out;
}

/**
 * Greedy wrapping: a line ends at a line break, or before the word that does not fit
 * (spaces hang past the edge rather than start a line); a word longer than the line is cut.
 * Without `words`, lines are cut anywhere (code).
 */
function wrap(
  glyphs: readonly Draft[],
  textX: number,
  width: number,
  options: { words: boolean },
): Line[] {
  const room = Math.max(1, width - textX);
  const lines: Line[] = [];
  let current: Draft[] = [];
  let from = 0;
  let used = 0;
  const flush = (to: number) => {
    let x = textX;
    lines.push({
      block: 0,
      from,
      to,
      textX,
      x: textX,
      bars: 0,
      glyphs: current.map((g) => {
        const placed = { ...g, x };
        x += g.width;
        return placed;
      }),
    });
    current = [];
    used = 0;
    from = to;
  };
  for (const glyph of glyphs) {
    if (glyph.text === "\n") {
      flush(glyph.offset);
      from = glyph.offset + 1;
      continue;
    }
    const space = glyph.text === " ";
    if (!space && used + glyph.width > room && current.length) {
      const breakAt = options.words ? lastSpace(current) : -1;
      if (breakAt >= 0 && breakAt < current.length - 1) {
        const carried = current.slice(breakAt + 1);
        current = current.slice(0, breakAt + 1);
        flush(carried[0]?.offset ?? glyph.offset);
        current = carried;
        used = carried.reduce((sum, g) => sum + g.width, 0);
      } else flush(glyph.offset);
    }
    current.push(glyph);
    used += glyph.width;
  }
  const last = glyphs.at(-1);
  flush(last ? last.offset + last.text.length : 0);
  return lines;
}
const lastSpace = (glyphs: readonly Draft[]) => glyphs.findLastIndex((g) => g.text === " ");
const lineEnd = (line: Line) => {
  const last = line.glyphs.at(-1);
  return last ? last.x + last.width : line.textX;
};

/** Whether `line` shows `offset` of its block: the line a cursor there is drawn on. */
function holds(lines: readonly Line[], index: number, offset: number) {
  const line = lines[index];
  if (!line || line.pad) return false;
  if (offset < line.from || offset > line.to) return false;
  if (offset < line.to) return true;
  const next = lines[index + 1];
  // At a soft wrap the cursor starts the next line; at a line break it ends this one.
  return !next || next.pad === true || next.block !== line.block || next.from > line.to;
}

/** The row and column a position is drawn at. */
export function cellOf(layout: Layout, pos: Pos): { row: number; col: number } {
  const { lines } = layout;
  let row = lines.findIndex((line, i) => line.block === pos.block && holds(lines, i, pos.offset));
  if (row < 0)
    row = Math.max(
      0,
      lines.findLastIndex((line) => line.block === pos.block && !line.pad),
    );
  const line = lines[row];
  if (!line) return { row: 0, col: 0 };
  const glyph = line.glyphs.find((g) => g.offset >= pos.offset);
  return { row, col: glyph ? glyph.x : lineEnd(line) };
}

/** The position a click at `row`, `col` lands on: before the character under it. */
export function posAt(layout: Layout, row: number, col: number): Pos {
  const { lines } = layout;
  let index = Math.max(0, Math.min(lines.length - 1, row));
  // A blank line between blocks belongs to the block below it (or above, at the end); a
  // row of a heading's band, to its title.
  const between = (i: number) => lines[i]?.block === -1 || lines[i]?.pad === true;
  const start = index;
  while (between(index) && index < lines.length - 1) index++;
  if (between(index) || (lines[start]?.pad && lines[index]?.block !== lines[start]?.block))
    for (index = start; between(index) && index > 0;) index--;
  const line = lines[index];
  if (!line) return { block: 0, offset: 0 };
  if (col < line.textX) return { block: line.block, offset: line.from };
  for (const glyph of line.glyphs)
    if (col < glyph.x + glyph.width) return { block: line.block, offset: glyph.offset };
  const next = lines[index + 1];
  // Past the end of a wrapped line: before its last character, not at the next line's start.
  const wrapped = next && next.block === line.block && next.from === line.to;
  const last = line.glyphs.at(-1);
  return { block: line.block, offset: wrapped && last ? last.offset : line.to };
}

/** Rows a document takes. */
export const heightOf = (layout: Layout) => layout.lines.length;
