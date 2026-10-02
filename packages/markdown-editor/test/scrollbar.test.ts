/**
 * How the editor scrolls, in numbers: how far a document may go past its last line, and
 * where the scrollbar's thumb lands for it (src/view/scrollbar.ts). No screen involved.
 */
import { expect, test } from "bun:test";
import { extentOf, glyphsOf, scrollForThumb, thumbOf } from "../src/view/scrollbar.ts";

const HEIGHT = 24;

test("a document that fits does not scroll: no tail, no thumb", () => {
  for (const lines of [0, 1, HEIGHT - 1, HEIGHT]) {
    const extent = extentOf(lines, HEIGHT);
    expect(extent).toMatchObject({ lines, tail: 0, content: lines, max: 0 });
    expect(thumbOf(extent, 0, HEIGHT)).toBeNull();
  }
});

test("a document one line too tall scrolls past its end by a quarter of the window", () => {
  const extent = extentOf(HEIGHT + 1, HEIGHT);
  expect(extent.tail).toBe(6);
  expect(extent.content).toBe(HEIGHT + 1 + 6);
  expect(extent.max).toBe(1 + 6);
  // The scrollbar accounts for the tail: the thumb is a share of lines and tail together.
  expect(thumbOf(extent, 0, HEIGHT)).toEqual({ from: 0, to: 37 });
});

test("the thumb is the window's share of the content, from the top to the bottom of the track", () => {
  // 120 lines through 24: a 6-row tail is not content, but it is scrolled through.
  const extent = extentOf(120, HEIGHT);
  expect(extent).toMatchObject({ tail: 6, content: 126, max: 102 });
  const track = HEIGHT * 2;
  const top = thumbOf(extent, 0, HEIGHT);
  expect(top).toEqual({ from: 0, to: Math.floor((track * HEIGHT) / 126) });
  const bottom = thumbOf(extent, extent.max, HEIGHT);
  expect(bottom?.to).toBe(track);
  expect((bottom?.to ?? 0) - (bottom?.from ?? 0)).toBe((top?.to ?? 0) - (top?.from ?? 0));
  // Halfway down the document, halfway down the track.
  const middle = thumbOf(extent, extent.max / 2, HEIGHT);
  expect(middle?.from).toBe(Math.round((track - (top?.to ?? 0)) / 2));
  // Never shorter than a half-row, however long the document.
  expect(thumbOf(extentOf(100_000, HEIGHT), 0, HEIGHT)).toEqual({ from: 0, to: 1 });
  // A scroll past the end is read as the end.
  expect(thumbOf(extent, 10_000, HEIGHT)).toEqual(bottom);
});

test("the thumb is drawn in full rows, its ends in half ones", () => {
  expect(glyphsOf({ from: 0, to: 4 }, 4)).toEqual(["█", "█", " ", " "]);
  expect(glyphsOf({ from: 1, to: 4 }, 4)).toEqual(["▄", "█", " ", " "]);
  expect(glyphsOf({ from: 2, to: 5 }, 4)).toEqual([" ", "█", "▀", " "]);
  expect(glyphsOf({ from: 3, to: 4 }, 4)).toEqual([" ", "▄", " ", " "]);
  expect(glyphsOf({ from: 7, to: 8 }, 4)).toEqual([" ", " ", " ", "▄"]);
});

test("a thumb put somewhere on the track means the scroll that draws it there", () => {
  const extent = extentOf(120, HEIGHT);
  for (const scroll of [0, 1, 17, 50, 103, extent.max]) {
    const thumb = thumbOf(extent, scroll, HEIGHT);
    const back = scrollForThumb(extent, thumb?.from ?? 0, HEIGHT);
    // The track has 48 halves for 102 positions: back within a position of the scroll.
    expect(Math.abs(back - scroll)).toBeLessThanOrEqual(2);
    expect(thumbOf(extent, back, HEIGHT)).toEqual(thumb);
  }
  // Dragged past either end, it stops there.
  expect(scrollForThumb(extent, -10, HEIGHT)).toBe(0);
  expect(scrollForThumb(extent, 1000, HEIGHT)).toBe(extent.max);
  // Nothing to scroll: nowhere to go.
  expect(scrollForThumb(extentOf(3, HEIGHT), 5, HEIGHT)).toBe(0);
});
