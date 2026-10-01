// Who a turn of the wheel over a live terminal belongs to, as a browser chains the wheel
// between nested scrollers: a gesture belongs to the application when, as it starts, what
// is under the pointer can still scroll that way, and to the page otherwise. Once given,
// it stays: the application's passes on to the page only when it reaches an end (and the
// rest of the gesture, its inertia included, then scrolls the page); the page's never
// passes back. A pause, or the wheel turning the other way, starts another gesture. So does
// nothing else: no guess from time, the answer comes from the screen (lucioleScrollRoom).

/** Whether the application can still scroll each way, under the pointer, as it shows. */
export type Room = { up: boolean; down: boolean };
export type Owner = "app" | "page";

/**
 * Turns further apart than this are two gestures. A trackpad's inertia, a wheel spun
 * notch after notch, send theirs closer: lifting the hand to start again is longer.
 */
export const GESTURE_GAP_MS = 300;

/** The decision, kept per terminal: `turn` for its frame's wheel, `outside` for the page's. */
export function wheelChain(gapMs = GESTURE_GAP_MS) {
  let owner: Owner = "page";
  let direction = 0;
  let last = -Infinity;
  const can = (room: Room | undefined, way: number) =>
    room === undefined || (way < 0 ? room.up : room.down);
  return {
    /**
     * A turn over the terminal at `time` (ms), `deltaY` as the event has it; `room` is
     * asked only when the answer matters. Says who scrolls for it.
     */
    turn(time: number, deltaY: number, room: () => Room | undefined): Owner {
      const way = Math.sign(deltaY);
      // Sideways only: nothing either way scrolls, the terminal ignores it.
      if (!way) {
        last = time;
        return "app";
      }
      const fresh = time - last > gapMs || way !== direction;
      last = time;
      direction = way;
      if (fresh) owner = can(room(), way) ? "app" : "page";
      else if (owner === "app" && !can(room(), way)) owner = "page";
      return owner;
    },
    /**
     * A turn the page scrolled for, outside the terminal: a gesture begun there stays the
     * page's when the terminal slides under the pointer.
     */
    outside(time: number, deltaY: number) {
      const way = Math.sign(deltaY);
      if (!way) return;
      last = time;
      direction = way;
      owner = "page";
    },
  };
}
