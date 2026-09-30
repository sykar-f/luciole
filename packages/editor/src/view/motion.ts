import { lengthOfBlock, textOfBlock } from "../model/doc.ts";
import { nextBoundary, previousBoundary, wordEnd, wordStart } from "../model/text.ts";
import type { Doc, Pos } from "../model/types.ts";
import { cellOf, posAt, type Layout } from "./layout.ts";

// Where the cursor goes. Left and right walk the text across blocks; up, down, Home and
// End walk the screen, so they read the layout.

export type Unit = "char" | "word";

export function moveHorizontal(doc: Doc, pos: Pos, direction: 1 | -1, unit: Unit): Pos {
  const block = doc[pos.block];
  if (!block) return pos;
  const text = textOfBlock(block);
  if (direction < 0) {
    if (pos.offset === 0) {
      const above = doc[pos.block - 1];
      return above ? { block: pos.block - 1, offset: lengthOfBlock(above) } : pos;
    }
    return {
      block: pos.block,
      offset: unit === "word" ? wordStart(text, pos.offset) : previousBoundary(text, pos.offset),
    };
  }
  if (pos.offset >= text.length)
    return doc[pos.block + 1] ? { block: pos.block + 1, offset: 0 } : pos;
  return {
    block: pos.block,
    offset: unit === "word" ? wordEnd(text, pos.offset) : nextBoundary(text, pos.offset),
  };
}

/**
 * One screen line up or down (`delta` lines), at the column the cursor had when vertical
 * moves began (`goal`), so it passes short lines without drifting.
 */
export function moveVertical(layout: Layout, pos: Pos, delta: number, goal: number | null) {
  const { row, col } = cellOf(layout, pos);
  const column = goal ?? col;
  let target = row + delta;
  // Blank lines between blocks, and the band rows around a title, are stepped over.
  const step = Math.sign(delta);
  while (layout.lines[target]?.block === -1 || layout.lines[target]?.pad) target += step;
  if (target < 0) return { pos: { block: 0, offset: 0 }, goal: column };
  if (target >= layout.lines.length) {
    const last = layout.lines.at(-1);
    return { pos: last ? { block: last.block, offset: last.to } : pos, goal: column };
  }
  return { pos: posAt(layout, target, column), goal: column };
}

/** The start or end of the screen line the cursor is on. */
export function lineEdge(layout: Layout, pos: Pos, edge: "start" | "end"): Pos {
  const { row } = cellOf(layout, pos);
  const line = layout.lines[row];
  if (!line) return pos;
  if (edge === "start") return { block: line.block, offset: line.from };
  const next = layout.lines[row + 1];
  const wrapped = next && next.block === line.block && next.from === line.to;
  const last = line.glyphs.at(-1);
  // A wrapped line ends before its hanging space, not at the next line's start.
  return {
    block: line.block,
    offset: wrapped && last ? (last.text === " " ? last.offset : line.to) : line.to,
  };
}
