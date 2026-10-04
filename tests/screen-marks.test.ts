import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { badges } from "../website/src/lib/marks.ts";
import type { Frame, FrameRegion, Run } from "../website/src/lib/transcripts.ts";

// Where a marked Screen draws its numbers (website/src/lib/marks.ts): on blank cells beside
// each region, never over the screen's text; a number with no room is reported, and
// check-kit fails the page that holds it.
const frames = join(import.meta.dir, "../website/src/frames");
const Capture = z.object({
  title: z.string(),
  cols: z.number(),
  rows: z.number(),
  cells: z.array(
    z.array(z.tuple([z.string(), z.nullable(z.string()), z.nullable(z.string()), z.string()])),
  ),
  regions: z.optional(
    z.array(
      z.object({
        id: z.string(),
        side: z.enum(["client", "server"]),
        rects: z.array(
          z.object({ row: z.number(), col: z.number(), rows: z.number(), cols: z.number() }),
        ),
      }),
    ),
  ),
});

/** A frame of plain rows, `#` a cell on a background. */
const frame = (rows: string[]): Frame => ({
  title: "t",
  cols: Math.max(...rows.map((row) => row.length)),
  rows: rows.length,
  cells: rows.map((row) =>
    Array.from(row, (char): Run =>
      char === "#" ? [" ", null, "#202020", ""] : [char, null, null, ""],
    ),
  ),
});
const region = (id: string, row: number, col: number, cols: number): FrameRegion => ({
  id,
  side: "client",
  rects: [{ row, col, rows: 1, cols }],
});

describe("a region's number", () => {
  test("sits on the nearest blank cells beside its region, left on a tie", () => {
    const placed = badges(frame(["ab   cdef   gh"]), [region("1", 0, 5, 4)]);
    expect(placed).toEqual({
      badges: [{ id: "1", side: "client", row: 0, col: 3, cols: 2 }],
      unplaced: [],
      gutter: 0,
    });
    // Farther on the left than on the right: the right wins.
    expect(badges(frame(["  x cdef  "]), [region("1", 0, 4, 4)]).badges[0]?.col).toBe(8);
  });

  test("takes no cell with text or a background, nor another number's", () => {
    const placed = badges(frame(["x# ab  cd  "]), [region("1", 0, 3, 2), region("2", 0, 7, 2)]);
    expect(placed.badges.map(({ id, col }) => [id, col])).toEqual([
      ["1", 5],
      ["2", 9],
    ]);
  });

  test("goes to the gutter for a region at the screen's edge, and opens it", () => {
    const placed = badges(frame(["abcdef", "ghijkl"]), [region("12", 1, 0, 6)]);
    expect(placed.badges).toEqual([{ id: "12", side: "client", row: 1, col: -3, cols: 3 }]);
    expect(placed.gutter).toBe(3);
  });

  test("on a row with no room, even in the gutter, is reported unplaced", () => {
    const placed = badges(frame(["abcdef", "a cdef"]), [
      region("1", 0, 0, 6),
      region("2", 0, 1, 3),
      region("3", 1, 2, 2),
    ]);
    // 3 has no blank pair on its row, so it takes the gutter; on 2's row, 1 took it.
    expect(placed.badges.map(({ id, row, col }) => [id, row, col])).toEqual([
      ["1", 0, -2],
      ["3", 1, -2],
    ]);
    expect(placed.unplaced).toEqual(["2"]);
  });

  test("on every capture that has regions, covers only blank cells", () => {
    const captures = readdirSync(frames).filter((name) => name.endsWith(".json"));
    let checked = 0;
    for (const name of captures) {
      const capture = Capture.parse(JSON.parse(readFileSync(join(frames, name), "utf8")));
      if (!capture.regions?.length) continue;
      const { badges: placed, unplaced } = badges(capture, capture.regions);
      expect({ name, unplaced }).toEqual({ name, unplaced: [] });
      const rows = capture.cells.map((runs) =>
        runs.flatMap(([text, , bg]) => Array.from(text, (char) => char === " " && !bg)),
      );
      for (const { row, col, cols } of placed)
        for (let c = Math.max(col, 0); c < col + cols; c++)
          expect({ name, row, c, blank: rows[row]?.[c] ?? true }).toEqual({
            name,
            row,
            c,
            blank: true,
          });
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(2);
  });
});
