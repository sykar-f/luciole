import type { RGBA } from "@opentui/core";
import { contentOf, joins, listNumber, textOfBlock } from "../model/doc.ts";
import { tableOf } from "../markdown/parse.ts";
import { cellWidth, graphemes } from "../model/text.ts";
import { quoteOf, type Block, type Doc, type Inline, type Pos } from "../model/types.ts";
import { groupsByOffset, type Highlights } from "./highlight.ts";
import { definitionsOf, imageOf, IMAGE_MARK, type Definitions, type ImageSize } from "./images.ts";
import { tableLines } from "./table.ts";
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
  /**
   * A heading's band: full from `x` up to `from`, then fading out until `to`. `cap`, drawn
   * in its first cell, rounds its left end.
   */
  readonly band?: {
    readonly color: RGBA;
    readonly from: number;
    readonly to: number;
    readonly cap?: string;
  };
  /**
   * A row with no text of its own: a heading's band above or below its title, a code
   * panel's margin, a table's border, an image's rows after its first. No cursor stops there.
   */
  readonly pad?: boolean;
  /** One row of an image `cols` cells wide and `rows` tall, drawn from `x`: its `row`th. */
  readonly image?: {
    readonly url: string;
    readonly row: number;
    readonly rows: number;
    readonly cols: number;
    readonly link?: string;
  };
  /** A label at the right end of the line: a code block's language. */
  readonly label?: { readonly text: string; readonly look: Look };
  readonly rule?: boolean;
};
export type Layout = { readonly lines: readonly Line[]; readonly width: number };

const BULLETS = ["•", "◦", "▪"];
// A task's box: three cells, a target the pointer finds.
const TASK_OPEN = "[ ]";
const TASK_DONE = "[✓]";
const LIST_INDENT = 2;
const QUOTE_INDENT = 2;
const CODE_PADDING = 2;
// As luciole's <Markdown> draws headings: the title two columns into its band, the band
// full up to a column fixed per level (a title typed in never moves it), then fading out.
// The deeper the level, the shorter the band (a share of the width): the eye tells the
// levels apart by it. H4 and H5 have a bar in the margin instead, H6 nothing but its color.
const TITLE_INDENT = 2;
const FADE_FROM: Readonly<Record<number, number>> = { 1: 28, 2: 18, 3: 12 };
const FADE_TO: Readonly<Record<number, number>> = { 1: 1, 2: 0.7, 3: 0.45 };
const MIN_FADE = 8;
const BARS: Readonly<Record<number, string>> = { 4: "▎", 5: "▏" };
// A band's rounded end: octants (Unicode 16) that leave out the band's outer corners.
const CAP_TOP = "\u{1CDE5}";
const CAP_BOTTOM = "\u{1CDAB}";
const CAP_BOTH = "\u{1CDAA}";
// Blank lines above a heading of each level, and below it: the deepest stick to their text.
const ABOVE: Readonly<Record<number, number>> = { 1: 2, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1 };
const BELOW: Readonly<Record<number, number>> = { 1: 1, 2: 1, 3: 1, 4: 0, 5: 0, 6: 0 };
// Raw blocks that are not content: link definitions, HTML comments.
const DEFINITION = /^(?:[ \t]*\[[^\]\n]+\]:[^\n]*(?:\n|$))+$/;
const COMMENT = /^<!--[\s\S]*-->$/;

// Blocks are immutable: a block's lines are computed once per theme, width, place and
// highlights, whatever else in the document changes.
type Cached = { readonly lines: readonly Line[]; readonly highlights: Highlights | undefined };
const caches = new WeakMap<Theme, WeakMap<Block, Map<string, Cached>>>();
type BlockContext = {
  /** Where the block starts: an item's marker, any other block's text. */
  readonly x: number;
  readonly number: number;
  /** The widest number of its ordered list, in cells: numbers line up on the right. */
  readonly numberWidth: number;
  /** Columns left of `x` a band or a panel reaches into. */
  readonly hang: number;
  /** Written as its Markdown: a table, an image being edited. */
  readonly revealed: boolean;
  readonly width: number;
  readonly theme: Theme;
  readonly highlights: Highlights | undefined;
  readonly caps: boolean;
  readonly definitions: Definitions;
  readonly image: LayoutOptions["image"];
  readonly cell: CellSize;
};

/** A cell's size in pixels. */
export type CellSize = { readonly width: number; readonly height: number };
// Without the terminal's word on it: a cell twice as tall as wide.
const DEFAULT_CELL: CellSize = { width: 8, height: 16 };

export type LayoutOptions = {
  /** The Tree-sitter highlights of a code block's text, when known. */
  highlight?: (block: number, lang: string, text: string) => Highlights | undefined;
  /**
   * Columns left of the text that heading bands and code panels start in (at most 2), so
   * that every block's text starts at the same column. None by default.
   */
  hang?: number;
  /** Bands with rounded ends, for terminals that draw octants. */
  caps?: boolean;
  /** The block shown as its Markdown whatever it is (a table, an image): the one edited. */
  revealed?: number;
  /**
   * An image's size in pixels once it can be drawn, "missing" if it cannot be had;
   * undefined draws its alternative text, for now or for good.
   */
  image?: (url: string) => ImageSize | "missing" | undefined;
  /**
   * Changes whenever images would be drawn otherwise (one arrived, the terminal said it
   * draws them, or its cell size): blocks holding images are laid out again.
   */
  images?: string;
  cell?: CellSize;
};
const MAX_HANG = 2;

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
  const definitions = definitionsOf(doc);
  const hang = Math.max(0, Math.min(MAX_HANG, options.hang ?? 0));
  const numberWidths = new Map<number, number>();
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
    const numberWidth = number ? widestNumber(doc, index, number, numberWidths) : 0;
    const highlights =
      block.type === "code" ? options.highlight?.(index, block.lang, block.text) : undefined;
    const placed = blockLines(
      block,
      {
        x,
        number,
        numberWidth,
        // Inside a quote, what hangs would cover its bar.
        hang: quote ? 0 : hang,
        revealed: options.revealed === index,
        width,
        theme,
        highlights,
        caps: options.caps === true,
        definitions,
        image: options.image,
        cell: options.cell ?? DEFAULT_CELL,
      },
      options.images ?? "",
    );
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
    // An H2 closing a section of deeper headings, one that has text: a line more.
    const closes = above === 2 && lastHeading >= SUBSECTION && !below;
    const lines = closes ? 2 : (ABOVE[above] ?? 1);
    return below ? Math.max(lines, BELOW[below] ?? 1) : lines;
  }
  if (below) return BELOW[below] ?? 1;
  // Two lists one after the other (their markers differ) are two lists, apart.
  if (startsAnotherList(doc, index)) return 1;
  return joins(doc, index) ? 0 : 1;
}
const SUBSECTION = 3;

/** The item above `doc[index]` at its own level, in the same list or the one before it. */
function itemBefore(doc: Doc, index: number) {
  const item = doc[index];
  if (item?.type !== "item") return undefined;
  for (let i = index - 1; i >= 0; i--) {
    const above = doc[i];
    if (!above || quoteOf(above) !== quoteOf(item)) return undefined;
    if (above.type !== "item") {
      if ((above.depth ?? 0) > item.indent) continue;
      return undefined;
    }
    if (above.indent > item.indent) continue;
    return above.indent === item.indent ? above : undefined;
  }
  return undefined;
}
function startsAnotherList(doc: Doc, index: number) {
  const item = doc[index];
  const before = itemBefore(doc, index);
  if (item?.type !== "item" || !before) return false;
  const ordered = (block: typeof item) => block.list === "ordered";
  return ordered(before) !== ordered(item) || before.marker !== item.marker;
}

/**
 * How many cells the widest number of the ordered list around `doc[index]` takes, its
 * number `number` known: counted once per list.
 */
function widestNumber(doc: Doc, index: number, number: number, known: Map<number, number>) {
  const cached = known.get(index);
  if (cached !== undefined) return cached;
  const item = doc[index];
  const rest: number[] = [];
  for (let i = index + 1; i < doc.length && item?.type === "item"; i++) {
    const below = doc[i];
    if (!below || quoteOf(below) !== quoteOf(item)) break;
    if (below.type !== "item") {
      if ((below.depth ?? 0) > item.indent) continue;
      break;
    }
    if (below.indent > item.indent) continue;
    if (below.indent < item.indent) break;
    if (below.list !== item.list || below.marker !== item.marker) break;
    rest.push(i);
  }
  const width = String(number + rest.length).length;
  for (const each of [index, ...rest]) known.set(each, width);
  return width;
}

function blockLines(block: Block, context: BlockContext, images: string): readonly Line[] {
  const { x, number, numberWidth, width, theme, highlights, hang, revealed, caps } = context;
  const key = `${width}:${number}:${numberWidth}:${x}:${hang}:${revealed}:${caps}:${holdsImage(block) ? images : ""}`;
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
  const { x, number, numberWidth, width, theme, hang, caps } = context;
  const at = { x, bars: 0 };
  if (block.type === "rule")
    return [{ block: 0, from: 0, to: 0, glyphs: [], textX: x, ...at, rule: true }];
  if (block.type === "raw") return rawLines(block.text, context);
  const base = theme.blockGroups(block);
  const glyphs = glyphsOf(block, base, context);
  if (block.type === "code") {
    // The panel reaches into the margin, so that the code starts where the text does.
    const panelX = x - hang;
    const textX = panelX + CODE_PADDING;
    const fill = theme.panel();
    const margin = (label?: Line["label"]): Line => ({
      block: 0,
      from: 0,
      to: 0,
      glyphs: [],
      textX,
      x: panelX,
      bars: 0,
      pad: true,
      ...(fill ? { fill } : {}),
      ...(label ? { label } : {}),
    });
    const code = wrap(glyphs, textX, width, { words: false }).map((line) => ({
      ...line,
      ...at,
      x: panelX,
      ...(fill ? { fill } : {}),
    }));
    const label = block.lang ? { text: block.lang, look: theme.label() } : undefined;
    return [margin(label), ...code, margin()];
  }
  switch (block.type) {
    case "heading": {
      const level = drawnLevel(block);
      const color = theme.band(level);
      const bandX = x - hang;
      const titleX = bandX + TITLE_INDENT;
      if (!color) {
        const bar = BARS[level];
        const shown = level === HEADING_LEVELS ? glyphs.map(upper) : glyphs;
        const look = level === BAR_FAINT ? { fg: theme.faint(), attributes: 0 } : theme.look(base);
        return wrap(shown, bar ? titleX : x, width, { words: true }).map((line, i) => ({
          ...line,
          ...at,
          ...(bar && i === 0 ? { marker: { x: bandX, text: bar, look } } : {}),
        }));
      }
      // The title is drawn on the band, which shows through it as it fades.
      const onBand = glyphs.map((g) => ({
        ...g,
        look: { fg: g.look.fg, attributes: g.look.attributes },
      }));
      const from = bandX + (FADE_FROM[level] ?? 0);
      const to = Math.max(from + MIN_FADE, Math.round(width * (FADE_TO[level] ?? 1)));
      const band = (cap: string) => ({ color, from, to, ...(caps && cap ? { cap } : {}) });
      const tall = level === 1;
      const title = wrap(onBand, titleX, width, { words: true }).map((line) => ({
        ...line,
        ...at,
        x: bandX,
        band: band(tall ? "" : CAP_BOTH),
      }));
      if (!tall) return title;
      // Level 1 is three rows tall, its title in the middle.
      const pad = (cap: string): Line => ({
        block: 0,
        from: 0,
        to: 0,
        glyphs: [],
        textX: titleX,
        x: bandX,
        bars: 0,
        band: band(cap),
        pad: true,
      });
      return [pad(CAP_TOP), ...title, pad(CAP_BOTTOM)];
    }
    case "item": {
      const text =
        block.list === "ordered"
          ? `${number}.`.padStart(numberWidth + 1)
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
      return (
        imageLines(block, context) ??
        wrap(glyphs, x, width, { words: true }).map((line) => ({ ...line, ...at }))
      );
  }
}
// H5's bar steps back; H4's has the heading's color.
const BAR_FAINT = 5;
/** A glyph in capitals, when that keeps it the same length. */
function upper(glyph: Draft): Draft {
  const text = glyph.text.toUpperCase();
  return text.length === glyph.text.length ? { ...glyph, text } : glyph;
}

/**
 * A raw block: a table drawn as one unless it is being edited, link definitions and HTML
 * comments stepping back, anything else as written.
 */
function rawLines(text: string, context: BlockContext): Line[] {
  const { x, width, theme, revealed } = context;
  const table = revealed ? null : tableOf(text);
  if (table)
    return tableLines(table, {
      x,
      width,
      theme,
      glyphs: (content, groups) => spansGlyphs(content, groups, context, null),
    });
  const groups = DEFINITION.test(text)
    ? ["conceal"]
    : COMMENT.test(text)
      ? ["comment"]
      : ["markup.raw"];
  const look = theme.look(groups);
  const glyphs = graphemes(text).map((g) => ({
    text: g.text,
    offset: g.offset,
    width: g.text === "\n" ? 0 : cellWidth(g.text),
    look,
  }));
  return wrap(glyphs, x, width, { words: true }).map((line) => ({ ...line, x, bars: 0 }));
}

type Found = { url: string; alt: string; from: number; to: number; link?: string };

/**
 * A paragraph of images alone, drawn as the images when the terminal can (else as their
 * alternative text), unless it is being edited: null for any other paragraph.
 */
function imageLines(block: Block, context: BlockContext): Line[] | null {
  const { x, width, revealed, definitions, image, cell } = context;
  if (revealed || block.type !== "paragraph") return null;
  const found: Found[] = [];
  let offset = 0;
  for (const span of block.content) {
    const read = span.marks.verbatim ? imageOf(span.text, definitions) : null;
    const from = offset;
    offset += span.text.length;
    const link = span.marks.link === undefined ? {} : { link: span.marks.link };
    if (read) found.push({ ...read, from, to: offset, ...link });
    else if (span.text.trim()) return null;
  }
  if (!found.length) return null;
  const lines: Line[] = [];
  for (const each of found) {
    const size = image?.(each.url);
    if (size === undefined || size === "missing") {
      const chip = chipGlyphs(each, context, { missing: size === "missing" });
      for (const line of wrap(chip, x, width, { words: true }))
        lines.push({ ...line, x, bars: 0, from: each.from, to: each.to });
      continue;
    }
    // As on a web page: the image at its own size, never wider than the text.
    const cols = Math.max(1, Math.min(width - x, Math.ceil(size.width / cell.width)));
    const rows = Math.max(
      1,
      Math.round((cols * cell.width * size.height) / size.width / cell.height),
    );
    const link = each.link === undefined ? {} : { link: each.link };
    for (let row = 0; row < rows; row++)
      lines.push({
        block: 0,
        from: each.from,
        to: each.from,
        glyphs: [],
        textX: x,
        x,
        bars: 0,
        image: { url: each.url, row, rows, cols, ...link },
        ...(row > 0 ? { pad: true } : {}),
      });
  }
  return lines;
}

/** Whether `block` holds an image, which lays it out again when images arrive. */
function holdsImage(block: Block) {
  if (block.type !== "paragraph" && block.type !== "item" && block.type !== "heading") return false;
  return block.content.some((span) => span.marks.verbatim && span.text.startsWith(IMAGE_MARK));
}

/** An image as its alternative text, over the Markdown it is written as. */
function chipGlyphs(
  image: Found,
  context: BlockContext,
  { missing }: { missing: boolean },
): Draft[] {
  const look = context.theme.look([missing ? "markup.image.missing" : "markup.image"]);
  const chip = graphemes(`${CHIP} ${image.alt || image.url}`);
  const length = image.to - image.from;
  return chip.map((g, i) => ({
    text: g.text,
    offset: image.from + Math.min(length - 1, Math.floor((i * length) / chip.length)),
    width: cellWidth(g.text),
    look,
    ...(image.link === undefined ? {} : { link: image.link }),
  }));
}
const CHIP = "▣";

function glyphsOf(block: Block, base: readonly string[], context: BlockContext): Draft[] {
  const code = context.highlights
    ? groupsByOffset(context.highlights, textOfBlock(block).length)
    : null;
  return spansGlyphs(contentOf(block), base, context, code);
}

/** `content` as glyphs over `base` groups, its offsets from 0. */
function spansGlyphs(
  content: Inline,
  base: readonly string[],
  context: BlockContext,
  code: readonly (readonly string[])[] | null,
): Draft[] {
  const { theme, revealed, definitions } = context;
  const out: Draft[] = [];
  let offset = 0;
  for (const span of content) {
    // An image among text: its alternative text, unless the block is being edited.
    const image = span.marks.verbatim && !revealed ? imageOf(span.text, definitions) : null;
    if (image) {
      const link = span.marks.link === undefined ? {} : { link: span.marks.link };
      const found = { ...image, from: offset, to: offset + span.text.length, ...link };
      out.push(...chipGlyphs(found, context, { missing: false }));
      offset += span.text.length;
      continue;
    }
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

export type Draft = {
  text: string;
  offset: number;
  width: number;
  look: Look;
  link?: string;
};

/**
 * Greedy wrapping: a line ends at a line break, or before the word that does not fit
 * (spaces hang past the edge rather than start a line); a word longer than the line is cut.
 * Without `words`, lines are cut anywhere (code).
 */
export function wrap(
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
