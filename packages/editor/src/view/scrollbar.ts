// How the editor scrolls, and shows it: where the page ends, how far it may go past its
// last line, and the scrollbar that says where the reader is. Pure arithmetic, in rows
// and half-rows: the renderable draws from it, the tests read it without a screen.

/**
 * A document scrolled through a window of `height` rows: how far it may go.
 *
 * A document that fits does not scroll at all. One that does not may scroll past its last
 * line by a `tail` of empty rows (a third of the window), so that the end of the text can
 * be read where the eye is, not pinned to the bottom edge. The tail is not content: the
 * Markdown does not hold it, and the cursor never goes there.
 */
export type Extent = {
  /** The document's own rows. */
  readonly lines: number;
  /** Empty rows past the last line, when the document scrolls. */
  readonly tail: number;
  /** Rows the scrollbar accounts for: `lines` and the tail. */
  readonly content: number;
  /** The farthest scroll: 0 for a document that fits. */
  readonly max: number;
};

/** The window's height is split in this many to make the tail. */
const TAIL_SHARE = 3;

export function extentOf(lines: number, height: number): Extent {
  const window = Math.max(0, height);
  const overflows = lines > window;
  const tail = overflows ? Math.floor(window / TAIL_SHARE) : 0;
  const content = lines + tail;
  return { lines, tail, content, max: overflows ? content - window : 0 };
}

/**
 * The thumb on a track of `track` rows, in half-rows (`from` inclusive, `to` exclusive):
 * as long as the window's share of the content, where the scroll's share of the way
 * puts it. Null for a document that does not scroll: no bar then.
 */
export type Thumb = { readonly from: number; readonly to: number };

/** A row is drawn in halves: the thumb's ends land on either. */
export const HALVES = 2;

export function thumbOf(extent: Extent, scroll: number, track: number): Thumb | null {
  if (extent.max <= 0 || track <= 0) return null;
  const length = track * HALVES;
  const window = extent.content - extent.max;
  const size = Math.max(1, Math.min(length, Math.floor((length * window) / extent.content)));
  const at = Math.max(0, Math.min(extent.max, scroll)) / extent.max;
  const from = Math.round(at * (length - size));
  return { from, to: from + size };
}

const FULL = "█";
const UPPER = "▀";
const LOWER = "▄";
const EMPTY = " ";

/** What each row of the track shows: the thumb in full rows, its ends in half ones. */
export function glyphsOf(thumb: Thumb, track: number): string[] {
  const rows: string[] = [];
  for (let row = 0; row < track; row++) {
    const start = row * HALVES;
    const covered = Math.min(thumb.to, start + HALVES) - Math.max(thumb.from, start);
    if (covered >= HALVES) rows.push(FULL);
    else if (covered <= 0) rows.push(EMPTY);
    else rows.push(Math.max(thumb.from, start) === start ? UPPER : LOWER);
  }
  return rows;
}

/**
 * The scroll that puts the thumb's top at `half` half-rows down the track: a thumb dragged
 * there, or the track clicked there with `half` the thumb's own middle. Clamped to the
 * document's extent.
 */
export function scrollForThumb(extent: Extent, half: number, track: number): number {
  const thumb = thumbOf(extent, 0, track);
  if (!thumb) return 0;
  const room = track * HALVES - (thumb.to - thumb.from);
  if (room <= 0) return 0;
  const at = Math.max(0, Math.min(room, half)) / room;
  return Math.round(at * extent.max);
}
