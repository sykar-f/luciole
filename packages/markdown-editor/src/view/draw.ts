import { RGBA, type NativeImage, type OptimizedBuffer } from "@opentui/core";
import { comparePos } from "../model/doc.ts";
import type { Pos } from "../model/types.ts";
import type { Layout, Line } from "./layout.ts";
import type { Theme } from "./theme.ts";

// A laid-out document drawn into a buffer, one visible row at a time.

export type Viewport = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** The first line of the layout drawn at `y`. */
  readonly scroll: number;
};

export type DrawOptions = {
  readonly selection: { from: Pos; to: Pos } | null;
  readonly placeholder?: string;
  /**
   * The terminal's own background (OSC 11), which heading bands fade into; without it
   * they fade in transparency.
   */
  readonly background?: RGBA;
  /** The task whose box is under the pointer (its block). */
  readonly hoveredTask?: number;
  /** How images are drawn, when the terminal draws them. */
  readonly images?: {
    readonly get: (url: string) => NativeImage | undefined;
    readonly protocol: "kitty" | "sixel";
    /** A cell's size in pixels, when the terminal told it. */
    readonly cell: { readonly width: number; readonly height: number } | null;
  };
};

const RULE = "─";
const BAR = "▎";
const QUOTE_STEP = 2;
// Past this much of the fade, a column is left unpainted: the terminal's own background,
// transparency included, shows at the edge.
const UNPAINTED = 0.95;

export function drawLayout(
  buffer: OptimizedBuffer,
  layout: Layout,
  view: Viewport,
  theme: Theme,
  options: DrawOptions,
) {
  const { selection } = options;
  const selected = (block: number, offset: number) =>
    selection !== null &&
    comparePos(selection.from, { block, offset }) <= 0 &&
    comparePos({ block, offset }, selection.to) < 0;
  const faint = theme.faint();
  const quoteBar = theme.quoteBar();
  for (let row = 0; row < view.height; row++) {
    const line = layout.lines[view.scroll + row];
    if (!line) break;
    const y = view.y + row;
    drawBackground(buffer, line, view, y, options.background);
    for (let bar = 0; bar < line.bars; bar++)
      buffer.drawText(BAR, view.x + bar * QUOTE_STEP, y, line.barColor ?? quoteBar);
    // An image from its first row on screen: the rows above the top are cut from it.
    if (line.image && (line.image.row === 0 || row === 0) && options.images)
      drawImage(
        buffer,
        line,
        view,
        y,
        Math.min(line.image.rows - line.image.row, view.height - row),
        options.images,
      );
    if (line.rule) {
      buffer.drawText(RULE.repeat(Math.max(0, view.width - line.x)), view.x + line.x, y, faint);
      if (
        selection &&
        comparePos(selection.from, { block: line.block, offset: 0 }) <= 0 &&
        selection.to.block > line.block
      )
        buffer.fillRect(view.x + line.x, y, 1, 1, theme.selection);
      continue;
    }
    if (line.marker) {
      const look =
        line.marker.task && options.hoveredTask === line.block
          ? theme.taskHover()
          : line.marker.look;
      buffer.drawText(
        line.marker.text,
        view.x + line.marker.x,
        y,
        look.fg,
        look.bg,
        look.attributes,
      );
    }
    if (line.label) {
      const x = view.x + Math.max(0, view.width - line.label.text.length - 1);
      buffer.drawText(
        line.label.text,
        x,
        y,
        line.label.look.fg,
        undefined,
        line.label.look.attributes,
      );
    }
    for (const glyph of line.glyphs) {
      if (glyph.x >= view.width) break;
      const bg = selected(line.block, glyph.offset) ? theme.selection : glyph.look.bg;
      buffer.drawText(glyph.text, view.x + glyph.x, y, glyph.look.fg, bg, glyph.look.attributes);
    }
    // An empty line inside the selection shows one selected cell, so it reads as taken.
    if (
      !line.glyphs.length &&
      !line.pad &&
      line.block >= 0 &&
      selection &&
      selectedLineEnd(line, selection)
    )
      buffer.fillRect(view.x + line.textX, y, 1, 1, theme.selection);
  }
  const first = layout.lines[0];
  if (options.placeholder && layout.lines.length === 1 && first && !first.glyphs.length)
    buffer.drawText(options.placeholder, view.x + first.textX, view.y, faint);
}

function selectedLineEnd(line: Line, selection: { from: Pos; to: Pos }) {
  const at = { block: line.block, offset: line.from };
  return comparePos(selection.from, at) <= 0 && comparePos(at, selection.to) < 0;
}

function drawBackground(
  buffer: OptimizedBuffer,
  line: Line,
  view: Viewport,
  y: number,
  background: RGBA | undefined,
) {
  if (line.fill)
    buffer.fillRect(view.x + line.x, y, Math.max(0, view.width - line.x), 1, line.fill);
  if (!line.band) return;
  const { color, from, to, cap } = line.band;
  // Full up to `from`, then fading out until `to`; its first cell rounded by `cap`.
  const span = Math.max(1, to - from);
  for (let cell = line.x; cell < Math.min(view.width, to); cell++) {
    const faded = Math.max(0, cell + 1 - from) / span;
    if (faded >= UNPAINTED) break;
    const shade = fade(color, background, faded);
    if (cell === line.x && cap) buffer.drawText(cap, view.x + cell, y, shade);
    else buffer.fillRect(view.x + cell, y, 1, 1, shade);
  }
}

/** `rows` rows of `line`'s image from `y`: the part of it that shows. */
function drawImage(
  buffer: OptimizedBuffer,
  line: Line,
  view: Viewport,
  y: number,
  rows: number,
  images: NonNullable<DrawOptions["images"]>,
) {
  const placed = line.image;
  const image = placed && images.get(placed.url);
  if (!placed || !image || rows <= 0) return;
  const top = Math.floor((placed.row / placed.rows) * image.height);
  const bottom = Math.ceil(((placed.row + rows) / placed.rows) * image.height);
  const { cell } = images;
  buffer.drawImage(
    image,
    view.x + line.x,
    y,
    placed.cols,
    rows,
    cell ? Math.round(placed.cols * cell.width) : 0,
    cell ? Math.round(rows * cell.height) : 0,
    0,
    top,
    image.width,
    Math.max(1, Math.min(image.height, bottom) - top),
    images.protocol,
  );
}

/** `band` faded by `amount` (0 to 1) into `background`, or into transparency without it. */
function fade(band: RGBA, background: RGBA | undefined, amount: number) {
  if (!background) return RGBA.fromValues(band.r, band.g, band.b, band.a * (1 - amount));
  const mix = (a: number, b: number) => a + (b - a) * amount;
  return RGBA.fromValues(
    mix(band.r, background.r),
    mix(band.g, background.g),
    mix(band.b, background.b),
    1,
  );
}
