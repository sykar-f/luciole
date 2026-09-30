import type { Align, Table } from "../markdown/parse.ts";
import { graphemes } from "../model/text.ts";
import type { Inline } from "../model/types.ts";
import { wrap, type Draft, type Line } from "./layout.ts";
import type { Look, Theme } from "./theme.ts";

// A GFM table drawn as one: columns sized to their cells (narrowed, their text wrapped,
// when the page is not wide enough), aligned as the delimiter row says, the header bold
// under a rule, in a box with rounded corners. Each cell's glyphs keep the offsets of its
// text in the Markdown, so a click lands in the right cell once the table is edited as
// written.

type Placed = Draft & { readonly x: number };

const PADDING = 1;
const MIN_COLUMN = 3;

type Context = {
  readonly x: number;
  readonly width: number;
  readonly theme: Theme;
  /** A cell's text as glyphs, their offsets from 0. */
  readonly glyphs: (content: Inline, groups: readonly string[]) => Draft[];
};

export function tableLines(table: Table, context: Context): Line[] {
  const { x, width, theme } = context;
  const border: Look = { fg: theme.faint(), attributes: 0 };
  const cells = table.rows.map((row, r) =>
    row.map((cell) => ({
      ...cell,
      glyphs: context.glyphs(cell.content, r === 0 ? ["markup.strong"] : []),
    })),
  );
  const count = Math.max(...cells.map((row) => row.length));
  const natural = Array.from({ length: count }, (_, c) =>
    Math.max(1, ...cells.map((row) => (row[c]?.glyphs ?? []).reduce((sum, g) => sum + g.width, 0))),
  );
  const widths = fit(natural, width - x - (count + 1) - count * PADDING * 2);

  const rule = (left: string, middle: string, right: string, at: number): Line => {
    let text = left;
    widths.forEach((w, c) => {
      text += "─".repeat(w + PADDING * 2) + (c === count - 1 ? right : middle);
    });
    return decor(text, x, at, border);
  };
  const lines: Line[] = [rule("╭", "┬", "╮", cells[0]?.[0]?.from ?? 0)];
  cells.forEach((row, r) => {
    const from = row[0]?.from ?? 0;
    const to = row.at(-1)?.to ?? from;
    // Each cell wrapped to its column; the row is as tall as its tallest cell.
    const wrapped = widths.map((w, c) => {
      const cell = row[c];
      if (!cell) return [];
      const shifted = cell.glyphs.map((g) => ({ ...g, offset: cell.from + g.offset }));
      return wrap(shifted, 0, w, { words: true }).map((line) => line.glyphs);
    });
    const height = Math.max(1, ...wrapped.map((each) => each.length));
    for (let i = 0; i < height; i++) {
      const glyphs: Placed[] = [];
      let col = x;
      const bar = (offset: number) => {
        glyphs.push({ text: "│", offset, width: 1, look: border, x: col });
        col += 1;
      };
      widths.forEach((w, c) => {
        const cell = row[c];
        bar(cell?.from ?? to);
        const text = wrapped[c]?.[i] ?? [];
        const used = text.reduce((sum, g) => sum + g.width, 0);
        const start = col + PADDING + offsetFor(table.align[c] ?? null, w - used);
        let at = start;
        for (const g of text) {
          glyphs.push({ ...g, x: at });
          at += g.width;
        }
        col += w + PADDING * 2;
      });
      bar(to);
      lines.push({
        block: 0,
        from,
        to,
        textX: x,
        x,
        bars: 0,
        glyphs,
        ...(i > 0 ? { pad: true } : {}),
      });
    }
    if (r === 0 && cells.length > 1) lines.push(rule("├", "┼", "┤", to));
  });
  lines.push(rule("╰", "┴", "╯", cells.at(-1)?.at(-1)?.to ?? 0));
  return lines;
}

/** Columns of `natural` widths within `room` cells: the widest ones give way first. */
function fit(natural: readonly number[], room: number) {
  const widths = [...natural];
  let total = widths.reduce((sum, w) => sum + w, 0);
  while (total > room) {
    const widest = widths.indexOf(Math.max(...widths));
    const w = widths[widest] ?? 0;
    if (w <= MIN_COLUMN) break;
    widths[widest] = w - 1;
    total--;
  }
  return widths;
}

const offsetFor = (align: Align, spare: number) =>
  align === "right" ? spare : align === "center" ? Math.floor(spare / 2) : 0;

/** A row of the box: drawn, holding no text, no cursor stopping there. */
function decor(text: string, x: number, offset: number, look: Look): Line {
  let col = x;
  const glyphs = graphemes(text).map((g) => ({ text: g.text, offset, width: 1, look, x: col++ }));
  return { block: 0, from: offset, to: offset, textX: x, x, bars: 0, glyphs, pad: true };
}
