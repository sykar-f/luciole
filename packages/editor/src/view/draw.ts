import { RGBA, type OptimizedBuffer } from "@opentui/core";
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
};

const RULE = "─";
const BAR = "│";
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
  for (let row = 0; row < view.height; row++) {
    const line = layout.lines[view.scroll + row];
    if (!line) break;
    const y = view.y + row;
    drawBackground(buffer, line, view, y, options.background);
    for (let bar = 0; bar < line.bars; bar++)
      buffer.drawText(BAR, view.x + bar * QUOTE_STEP, y, faint);
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
    if (line.marker)
      buffer.drawText(
        line.marker.text,
        view.x + line.marker.x,
        y,
        line.marker.look.fg,
        undefined,
        line.marker.look.attributes,
      );
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
  const { color, from } = line.band;
  // Full up to `from`, then fading out over what is left of the width.
  const span = Math.max(1, view.width - from);
  for (let cell = line.x; cell < view.width; cell++) {
    const faded = Math.max(0, cell + 1 - from) / span;
    if (faded >= UNPAINTED) break;
    buffer.fillRect(view.x + cell, y, 1, 1, fade(color, background, faded));
  }
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
