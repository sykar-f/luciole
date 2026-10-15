/* eslint-disable typescript/consistent-type-assertions -- Partial renderer, viewport and immutable map doubles isolate controller lifecycle and frame encoding from a native renderer. */
import { EventEmitter } from "node:events";
import type { CliRenderer } from "@opentui/core";
import { PixelController } from "../packages/core/src/web/pixel-scroll/controller";
import { OrdinaryPixelInput } from "../packages/core/src/web/pixel-scroll/ordinary-input";
import { PixelHistory, RETAINED_GENERATIONS } from "../packages/core/src/web/pixel-scroll/history";
import { PixelDiscovery } from "../packages/core/src/web/pixel-scroll/discovery";
import { expect, test } from "bun:test";
import { decode, encode } from "../packages/core/src/pixel-scroll/protocol";
import {
  clipPixelRect,
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
  expect(discovery.receive(capability(current.nonce, "invalidated"))?.reason).toBe("invalidated");
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

test("embedded replay accumulates precise wheel rows and preserves the remainder", () => {
  const input = new OrdinaryPixelInput();
  const wheel = (dy: number) =>
    input.convert(
      encode({
        op: "wheel",
        version: 1,
        id: 1,
        generation: 9,
        x: 3.75,
        y: 4.5,
        phase: 0.5,
        modifiers: 0,
        dx: 0,
        dy,
        source: "precise",
      }),
    );
  expect(wheel(3)).toBe("\x1b[<65;4;5M".repeat(3));
  expect(Array.from({ length: 5 }, () => wheel(0.42)).join("")).toBe("\x1b[<65;4;5M".repeat(2));
  expect(wheel(0.9)).toBe("\x1b[<65;4;5M");
  expect(wheel(-0.25)).toBe("");
  expect(wheel(-0.75)).toBe("\x1b[<64;4;5M");
  expect(input.convert("keys")).toBe("keys");
});

test("embedded pointer replay uses ordinary SGR buttons, cells and modifiers", () => {
  const input = new OrdinaryPixelInput();
  const pointer = (
    action: "move" | "down" | "up" | "drag",
    button: number,
    buttons: number,
    modifiers = 0,
  ) =>
    input.convert(
      encode({
        op: "pointer",
        version: 1,
        id: 1,
        generation: 9,
        x: 3.75,
        y: 4.5,
        phase: 0.5,
        modifiers,
        action,
        button,
        buttons,
      }),
    );
  expect(pointer("down", 0, 1, 7)).toBe("\x1b[<28;4;5M");
  expect(pointer("drag", -1, 1)).toBe("\x1b[<32;4;5M");
  expect(pointer("drag", -1, 2)).toBe("\x1b[<34;4;5M");
  expect(pointer("drag", -1, 4)).toBe("\x1b[<33;4;5M");
  expect(pointer("move", -1, 0)).toBe("\x1b[<35;4;5M");
  expect(pointer("up", 2, 0, 2)).toBe("\x1b[<10;4;5m");
});

test("nested surface rectangles clip to visible content and terminal cells", () => {
  const screen = { x: 0, y: 0, width: 20, height: 10 };
  const parent = { x: 2, y: 1, width: 8, height: 6 };
  expect(clipPixelRect({ x: 1, y: -2, width: 8, height: 6 }, [screen, parent])).toEqual({
    x: 2,
    y: 1,
    width: 7,
    height: 3,
  });
  expect(clipPixelRect({ x: 2, y: 12, width: 8, height: 6 }, [screen])).toBeUndefined();
});

test("popup canonical repaint refreshes fixed chrome before the release command", () => {
  const plan = planPixelFrame(fixture(0), true, true);
  expect(messages(plan.after).map((p) => p?.op)).toEqual(["register"]);
  expect(plan.projection?.translateY).toBe(-10);
  expect(messages(plan.projection?.after).map((p) => p?.op)).toEqual(["step", "commit", "release"]);
});

test("ordinary SGR input after disposal never accesses the renderer", () => {
  const osc = new EventEmitter();
  const writes: string[] = [];
  let hits = 0;
  let renders = 0;
  const renderer = Object.assign(new EventEmitter(), {
    keyInput: new EventEmitter(),
    setFramePlan: () => {},
    captureHitMap: () => {
      throw new Error("Unexpected frame capture");
    },
    dispatchMouseEventFromHitMap: () => false,
    subscribeOsc: (receive: (sequence: string) => void) => {
      osc.on("sequence", receive);
      return () => {
        osc.off("sequence", receive);
      };
    },
    hitTest: () => {
      hits++;
      return 0;
    },
    requestRender: () => {
      renders++;
    },
  });
  const controller = PixelController.attach(renderer as unknown as CliRenderer, (s) =>
    writes.push(s),
  );
  if (!controller) throw new Error("Missing controller");
  const discovery = writes[0];
  if (!discovery) throw new Error("Missing discovery output");
  const query = decode(discovery.slice("\x1b[?2026h".length, -"\x1b[?2026l".length));
  if (query?.op !== "query") throw new Error("Missing discovery query");
  osc.emit(
    "sequence",
    encode({
      op: "capability",
      version: 1,
      nonce: query.nonce,
      reason: "ready",
      snapshot: true,
      precise: true,
    }),
  );
  controller.ordinary("\x1b[<65;4;5M");
  expect(hits).toBe(1);
  controller.dispose();
  hits = renders = 0;
  controller.ordinary("\x1b[<65;4;5M");
  controller.ordinary("\x1b[<0;4;5M");
  controller.dispose();
  expect(hits).toBe(0);
  expect(renders).toBe(0);
});
