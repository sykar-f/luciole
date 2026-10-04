// Where a marked Screen draws each region's number: on blank cells of the frame, so a badge
// never hides what the legend sends the reader to find. Plain TypeScript, run at build time
// by Screen.astro and under Bun by the tests.
import type { Frame, FrameRegion } from "./transcripts";

/**
 * A region's number, over `cols` cells of one row. A negative `col` is in the gutter the
 * screen opens on its left, `gutter` cells wide.
 */
export type Badge = {
  id: string;
  side: FrameRegion["side"];
  row: number;
  col: number;
  cols: number;
};

/**
 * Each region's badge, beside its first rectangle on the rectangle's first row: on the
 * nearest run of blank cells to its left or right (left on a tie), else in the gutter. A
 * cell is blank when it holds a space on no background, and no other badge sits on it. A
 * region whose row has room nowhere is `unplaced`.
 */
export function badges(frame: Frame, regions: FrameRegion[]) {
  const blank = frame.cells.map((runs) => {
    const cells: boolean[] = [];
    for (const [text, , bg] of runs) for (const char of text) cells.push(char === " " && !bg);
    return cells;
  });
  const taken = new Set<string>();
  const free = (row: number, col: number, cols: number) => {
    for (let c = col; c < col + cols; c++) {
      if (taken.has(`${row}:${c}`)) return false;
      if (c >= 0 && (c >= frame.cols || blank[row]?.[c] === false)) return false;
    }
    return true;
  };
  const placed: Badge[] = [];
  const unplaced: string[] = [];
  let gutter = 0;
  for (const { id, side, rects } of regions) {
    const rect = rects[0];
    if (!rect) {
      unplaced.push(id);
      continue;
    }
    const cols = id.length + 1;
    const { row } = rect;
    let left: number | undefined;
    for (let col = rect.col - cols; col >= 0 && left === undefined; col--)
      if (free(row, col, cols)) left = col;
    let right: number | undefined;
    const after = rect.col + rect.cols;
    for (let col = after; col + cols <= frame.cols && right === undefined; col++)
      if (free(row, col, cols)) right = col;
    const leftGap = left === undefined ? Infinity : rect.col - (left + cols);
    const rightGap = right === undefined ? Infinity : right - after;
    let col = leftGap <= rightGap ? left : right;
    if (col === undefined && free(row, -cols, cols)) {
      col = -cols;
      gutter = Math.max(gutter, cols);
    }
    if (col === undefined) {
      unplaced.push(id);
      continue;
    }
    for (let c = col; c < col + cols; c++) taken.add(`${row}:${c}`);
    placed.push({ id, side, row, col, cols });
  }
  return { badges: placed, unplaced, gutter };
}
