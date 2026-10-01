// The live terminal's cells, as the web runtime sizes them (packages/luciole/src/web/platform/
// run.tsx, `fitGrid`): its fonts, the largest size on its steps at which the grid fits, and
// the cell xterm.js draws at that size. A page that shows a capture until the runtime draws
// can give it the same size beforehand: nothing moves when one replaces the other.

/** What terminals draw with, before a generic monospace: the runtime's. */
export const FONTS =
  'ui-monospace, "SF Mono", Menlo, "Cascadia Mono", Consolas, "DejaVu Sans Mono", monospace';
export const LARGEST_FONT = 24;
export const SMALLEST_FONT = 4;
export const FONT_STEP = 0.25;

export type GridSize = { fontSize: number; width: number; height: number };

let context: OffscreenCanvasRenderingContext2D | null | undefined;

/**
 * The grid of `columns` by `rows` cells at its largest font no wider than `room` pixels, as
 * xterm.js measures its font (canvas text metrics) and its GPU renderer rounds its cells:
 * each a whole device pixel wide and high (the DOM renderer, which the runtime falls back
 * on without WebGL2, keeps a fractional width: a grid a few pixels wider); undefined where
 * the browser does not measure fonts that way.
 */
export function gridSize(columns: number, rows: number, room: number): GridSize | undefined {
  context ??=
    typeof OffscreenCanvas === "function" ? new OffscreenCanvas(1, 1).getContext("2d") : null;
  if (!context) return undefined;
  const ratio = devicePixelRatio;
  const at = (fontSize: number): GridSize | undefined => {
    if (!context) return undefined;
    context.font = `${fontSize}px ${FONTS}`;
    const metrics = context.measureText("W");
    if (!("fontBoundingBoxAscent" in metrics)) return undefined;
    const cell = {
      width: Math.floor(metrics.width * ratio),
      height: Math.ceil((metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent) * ratio),
    };
    return {
      fontSize,
      width: Math.round((cell.width * columns) / ratio),
      height: Math.round((cell.height * rows) / ratio),
    };
  };
  for (let fontSize = LARGEST_FONT; fontSize >= SMALLEST_FONT; fontSize -= FONT_STEP) {
    const size = at(fontSize);
    if (!size) return undefined;
    if (size.width <= room) return size;
  }
  return at(SMALLEST_FONT);
}
