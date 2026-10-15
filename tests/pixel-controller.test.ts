import { expect, test } from "bun:test";
import { decode } from "../packages/core/src/pixel-scroll/protocol";
import {
  pixelHitSource,
  planPixelFrame,
  type PixelFrame,
} from "../packages/core/src/web/pixel-scroll/frame";
import type { RenderHitMap, ScrollableViewport } from "../packages/core/src/web/opentui-seams";

function fixture(fraction = 0.25) {
  const viewport = {
    project: (origin: number) => ({ renderable: {}, translateX: 0, translateY: -origin }),
  } as ScrollableViewport;
  const frame: PixelFrame = {
    id: 1,
    generation: 7,
    viewport,
    rect: { x: 2, y: 3, width: 8, height: 4 },
    origin: 10,
    fraction,
  };
  return frame;
}
const messages = (bytes: Uint8Array | undefined) =>
  new TextDecoder()
    .decode(bytes)
    .split("\x1b\\")
    .filter(Boolean)
    .map((s) => decode(s + "\x1b\\"));

test("frame commands capture the integer origin before projecting and commit once", () => {
  const frame = fixture();
  const plan = planPixelFrame(frame);
  expect(messages(plan.before)).toEqual([{ op: "begin", version: 1, generation: 7 }]);
  expect(messages(plan.after)).toEqual([
    { op: "register", version: 1, id: 1, generation: 7, rect: frame.rect, origin: 10 },
  ]);
  expect(plan.projection?.translateY).toBe(-11);
  expect(messages(plan.projection?.after)).toEqual([
    { op: "step", version: 1, id: 1, generation: 7, fraction: 0.25 },
    { op: "commit", version: 1, generation: 7 },
  ]);
  expect(frame.fraction).toBe(0.25);
});

test("canonical release follows its complete transaction without a projection", () => {
  const plan = planPixelFrame(fixture(0), true);
  expect(plan.projection).toBeUndefined();
  expect(messages(plan.after).map((p) => p?.op)).toEqual(["register", "step", "commit", "release"]);
  expect(() => planPixelFrame(fixture(), true)).toThrow("canonical");
});

test("hit routing uses the reported phase and the entering edge's projection map", () => {
  const frame = fixture();
  frame.snapshot = { passId: 1 } as RenderHitMap;
  frame.projection = { passId: 2 } as RenderHitMap;
  expect(pixelHitSource(frame, 4, 5.9, 0.25)).toEqual({ map: frame.snapshot, x: 4, y: 6.15 });
  expect(pixelHitSource(frame, 4, 6.9, 0.25)).toEqual({ map: frame.projection, x: 4, y: 6.15 });
  expect(pixelHitSource(frame, 4, 6.9, 0).map).toBe(frame.snapshot);
  expect(pixelHitSource(frame, 4, 6.9, 1).map).toBe(frame.projection);
  expect(pixelHitSource(frame, 1, 6.9, 1)).toEqual({ map: frame.snapshot, x: 1, y: 6.9 });
});
