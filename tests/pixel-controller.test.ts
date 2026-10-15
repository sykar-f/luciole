/* eslint-disable typescript/consistent-type-assertions -- Partial viewport and immutable map doubles isolate the frame encoder from a native renderer. */
import { PixelHistory, RETAINED_GENERATIONS } from "../packages/core/src/web/pixel-scroll/history";
import { PixelDiscovery } from "../packages/core/src/web/pixel-scroll/discovery";
import { expect, test } from "bun:test";
import { decode, encode } from "../packages/core/src/pixel-scroll/protocol";
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

test("discovery never blocks and accepts only the current supported nonce", () => {
  const discovery = new PixelDiscovery();
  const old = decode(discovery.query());
  const current = decode(discovery.query());
  if (old?.op !== "query" || current?.op !== "query") throw new Error("Missing query");
  const capability = (nonce: string, reason: "ready" | "invalidated" = "ready") =>
    encode({
      op: "capability",
      version: 1,
      nonce,
      reason,
      snapshot: reason === "ready",
      precise: reason === "ready",
    });
  expect(discovery.ready).toBe(false);
  expect(discovery.receive("unknown")).toBeUndefined();
  expect(discovery.receive(capability(old.nonce))).toBeUndefined();
  discovery.receive(capability(current.nonce));
  expect(discovery.ready).toBe(true);
  expect(discovery.mode()).toEndWith("h");
  discovery.receive(capability(current.nonce, "invalidated"));
  expect(discovery.ready).toBe(false);
  expect(discovery.mode()).toEndWith("l");
  expect(discovery.receive(capability(current.nonce))).toBeUndefined();
  expect(discovery.ready).toBe(false);
});

test("bounded generation history rejects evicted, stale and mismatched input", () => {
  const history = new PixelHistory();
  const frames = Array.from({ length: RETAINED_GENERATIONS + 1 }, (_, i) => ({
    ...fixture(),
    generation: i + 1,
  }));
  for (const frame of frames) history.add(frame);
  expect(history.get(1, 1)).toBeUndefined();
  expect(history.get(2, 2)).toBeUndefined();
  expect(history.get(1, 2)).toBe(frames[1]);
  expect(history.get(1, RETAINED_GENERATIONS)).toBe(frames[RETAINED_GENERATIONS - 1]);
  expect(history.get(1, 2)).toBeUndefined();
  history.clear();
  expect(history.get(1, RETAINED_GENERATIONS)).toBeUndefined();
});
