/**
 * Who scrolls for a turn of the wheel over a live terminal of the landing page
 * (website/src/lib/wheel.ts): the application while it has room that way, the page once
 * it has none, gesture by gesture, as a browser chains the wheel between nested scrollers.
 */
import { expect, test } from "bun:test";
import { GESTURE_GAP_MS, wheelChain, type Owner, type Room } from "../website/src/lib/wheel";

const FRAME_MS = 16;
const DOWN = 8;
const UP = -8;
const room = (up: boolean, down: boolean): Room => ({ up, down });
const BOTH = room(true, true);
const NONE = room(false, false);
const AT_TOP = room(false, true);
const AT_END = room(true, false);
/** `count` times the same thing: turns, rooms, owners. */
const times = <T>(count: number, value: T): T[] => Array.from({ length: count }, () => value);

/** Plays turns 16 ms apart from `start`; `rooms` answers for each (the last one repeats). */
function play(
  chain: ReturnType<typeof wheelChain>,
  deltas: readonly number[],
  rooms: readonly (Room | undefined)[],
  start = 0,
) {
  return deltas.map((delta, i) =>
    chain.turn(start + i * FRAME_MS, delta, () => rooms[Math.min(i, rooms.length - 1)]),
  );
}

test("a gesture over something with room goes to the application, however slowly it answers", () => {
  // The room is what the screen shows: over SSH it may not move for a second; the
  // application keeps the gesture all the same.
  const owners = play(wheelChain(), times(60, DOWN), [AT_TOP]);
  expect(new Set(owners)).toEqual(new Set(["app"]));
});

test("a gesture over nothing to scroll goes to the page from its first turn", () => {
  expect(new Set(play(wheelChain(), times(20, DOWN), [NONE]))).toEqual(new Set(["page"]));
  expect(new Set(play(wheelChain(), times(20, UP), [AT_TOP]))).toEqual(new Set(["page"]));
});

test("reaching an end passes the rest of the gesture, its inertia included, to the page", () => {
  const owners = play(wheelChain(), times(30, DOWN), [
    ...times(10, BOTH),
    AT_END,
    BOTH, // the application scrolled back meanwhile: the gesture stays the page's
  ]);
  expect(owners.slice(0, 10)).toEqual(times<Owner>(10, "app"));
  expect(new Set(owners.slice(10))).toEqual(new Set(["page"]));
});

test("a gesture the page has never passes back to the application", () => {
  const owners = play(wheelChain(), times(30, DOWN), [NONE, BOTH]);
  expect(new Set(owners)).toEqual(new Set(["page"]));
});

test("turning the other way starts another gesture, asked again", () => {
  const chain = wheelChain();
  play(chain, times(10, DOWN), [AT_END]);
  expect(chain.turn(10 * FRAME_MS, UP, () => AT_END)).toBe("app");
});

test("a pause starts another gesture; inertia, close turns, does not", () => {
  const chain = wheelChain();
  play(chain, times(5, DOWN), [NONE]);
  const last = 4 * FRAME_MS;
  const close = last + GESTURE_GAP_MS;
  expect(chain.turn(close, DOWN, () => BOTH)).toBe("page");
  expect(chain.turn(close + GESTURE_GAP_MS + 1, DOWN, () => BOTH)).toBe("app");
});

test("a gesture begun on the page stays the page's when the terminal slides under the pointer", () => {
  const chain = wheelChain();
  for (let i = 0; i < 10; i++) chain.outside(i * FRAME_MS, UP);
  const owners = play(chain, times(20, UP), [BOTH], 10 * FRAME_MS);
  expect(new Set(owners)).toEqual(new Set(["page"]));
});

test("a terminal that cannot say keeps the wheel; a sideways turn is left to it", () => {
  expect(new Set(play(wheelChain(), times(10, DOWN), [undefined]))).toEqual(new Set(["app"]));
  const chain = wheelChain();
  play(chain, times(5, DOWN), [NONE]);
  expect(chain.turn(5 * FRAME_MS, 0, () => NONE)).toBe("app");
  // ...without ending the page's gesture.
  expect(chain.turn(6 * FRAME_MS, DOWN, () => BOTH)).toBe("page");
});

test("the room is asked only when the answer matters", () => {
  let asked = 0;
  const chain = wheelChain();
  for (let i = 0; i < 10; i++)
    chain.turn(i * FRAME_MS, DOWN, () => {
      asked++;
      return NONE;
    });
  expect(asked).toBe(1);
});
