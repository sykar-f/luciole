/* eslint-disable typescript/consistent-type-assertions -- Partial renderer, viewport and immutable map doubles isolate controller lifecycle and frame encoding from a native renderer. */
import { EventEmitter } from "node:events";
import { Renderable, type CliRenderer } from "@opentui/core";
import { PixelController } from "../packages/core/src/web/pixel-scroll/controller";
import { OrdinaryPixelInput } from "../packages/core/src/web/pixel-scroll/ordinary-input";
import { PixelHistory, RETAINED_GENERATIONS } from "../packages/core/src/web/pixel-scroll/history";
import { PixelDiscovery } from "../packages/core/src/web/pixel-scroll/discovery";
import { expect, test } from "bun:test";
import { decode, encode } from "../packages/core/src/pixel-scroll/protocol";
import {
  clipPixelRect,
  painterHitMap,
  pixelHitSource,
  planPixelFrame,
  type PixelFrame,
} from "../packages/core/src/web/pixel-scroll/frame";
import type {
  RenderFramePlan,
  RenderHitMap,
  ScrollableViewport,
} from "../packages/core/src/web/opentui-seams";

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

function discoveryQuery(wire: string) {
  const sequence = wire.slice("\x1b[?2026h".length, -"\x1b[?2026l".length);
  return messages(new TextEncoder().encode(sequence))[0];
}

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
  const old = messages(new TextEncoder().encode(discovery.query()))[0];
  const current = messages(new TextEncoder().encode(discovery.query()))[0];
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
  const query = discoveryQuery(discovery);
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

test("viewport key ownership is optional and keeps modified Page routing", () => {
  for (const keepsKeys of [false, true]) {
    const osc = new EventEmitter(),
      keyInput = new EventEmitter();
    const owner = {} as Renderable;
    let position = 0;
    const viewport: ScrollableViewport = {
      owner,
      ...(keepsKeys ? { scrollKeys: false as const } : {}),
      get position() {
        return position;
      },
      origin: 0,
      max: 100,
      rect: { x: 0, y: 0, width: 20, height: 10 },
      set: (value) => {
        position = value;
      },
      scroll: (delta) => {
        position += delta;
        return 0;
      },
      project: () => ({ renderable: owner, translateX: 0, translateY: 0 }),
    };
    Object.assign(owner, { scrollableViewport: viewport });
    let query: ReturnType<typeof decode>;
    const renderer = Object.assign(new EventEmitter(), {
      keyInput,
      currentFocusedRenderable: owner,
      requestRender: () => {},
      setFramePlan: () => {},
      captureHitMap: () => ({}),
      dispatchMouseEventFromHitMap: () => false,
      subscribeOsc: (receive: (sequence: string) => void) => {
        osc.on("sequence", receive);
        return () => {
          osc.off("sequence", receive);
        };
      },
    });
    const controller = PixelController.attach(renderer as unknown as CliRenderer, (wire) => {
      if (!query) query = discoveryQuery(wire);
    });
    if (query?.op !== "query" || !controller) throw new Error("Missing controller query");
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
    const send = (name: string, ctrl = false) => {
      const key = {
        name,
        ctrl,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      keyInput.emit("keypress", key);
      return key.defaultPrevented;
    };
    expect(send("down")).toBe(!keepsKeys);
    expect(position).toBe(keepsKeys ? 0 : 1);
    expect(send("pagedown")).toBe(!keepsKeys);
    expect(position).toBe(keepsKeys ? 0 : 10);
    expect(send("pagedown", true)).toBe(true);
    expect(position).toBe(keepsKeys ? 9 : 19);
    Object.assign(renderer, { currentFocusedRenderable: { parent: owner } });
    expect(send("down")).toBe(false);
    expect(send("pageup", true)).toBe(true);
    controller.dispose();
  }
});

test("owner pointer dispatch scopes the named origin without changing event coordinates", () => {
  for (const scoped of [true, false]) {
    const id = 10_000;
    const owner = {
      num: id,
      visible: true,
      isDestroyed: false,
      parent: null,
      getChildren: () => [],
    } as unknown as Renderable;
    let origin = 0,
      inputOrigin: number | undefined;
    const viewport: ScrollableViewport = {
      owner,
      get position() {
        return origin + 0.75;
      },
      get origin() {
        return origin;
      },
      max: 100,
      rect: { x: 0, y: 0, width: 20, height: 10 },
      set: (value) => {
        origin = Math.floor(value);
      },
      scroll: () => 0,
      project: () => ({ renderable: owner, translateX: 0, translateY: -1 }),
      ...(scoped
        ? {
            input: (value: number, dispatch: () => boolean) => {
              inputOrigin = value;
              try {
                return dispatch();
              } finally {
                inputOrigin = undefined;
              }
            },
          }
        : {}),
    };
    Object.assign(owner, { scrollableViewport: viewport });
    Renderable.renderablesByNumber.set(id, owner);
    const map: RenderHitMap = {
      width: 20,
      height: 10,
      frameId: 1,
      passId: 1,
      hitTest: () => id,
      origin: () => ({ x: 0, y: 0 }),
    };
    const osc = new EventEmitter();
    let factory: (() => RenderFramePlan | null) | null = null;
    const observed: { origin: number | undefined; x: number; y: number; position: number }[] = [];
    const writes: string[] = [];
    const renderer = Object.assign(new EventEmitter(), {
      root: owner,
      width: 20,
      height: 10,
      currentFocusedRenderable: owner,
      keyInput: new EventEmitter(),
      nextRenderBuffer: {
        withBuffers: (
          read: (access: {
            char: Uint32Array;
            fg: Uint16Array;
            bg: Uint16Array;
            attributes: Uint32Array;
          }) => boolean,
        ) =>
          read({
            char: new Uint32Array([1]),
            fg: new Uint16Array(),
            bg: new Uint16Array(),
            attributes: new Uint32Array(),
          }),
      },
      requestRender: () => {},
      captureHitMap: () => map,
      setFramePlan: (value: (() => RenderFramePlan | null) | null) => {
        factory = value;
      },
      dispatchMouseEventFromHitMap: (event: { x: number; y: number }) => {
        observed.push({ origin: inputOrigin, x: event.x, y: event.y, position: viewport.position });
        return true;
      },
      subscribeOsc: (receive: (sequence: string) => void) => {
        osc.on("sequence", receive);
        return () => {
          osc.off("sequence", receive);
        };
      },
    });
    const controller = PixelController.attach(renderer as unknown as CliRenderer, (wire) =>
      writes.push(wire),
    );
    try {
      const wire = writes[0];
      if (!controller || !wire) throw new Error("Missing controller query");
      const query = discoveryQuery(wire);
      if (query?.op !== "query") throw new Error("Missing query");
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
      const createPlan = factory as (() => RenderFramePlan | null) | null;
      const plan = createPlan?.();
      if (!plan) throw new Error("Missing frame plan");
      plan.onHitMap?.(map);
      plan.projection?.onHitMap?.(map);
      origin = 2;
      osc.emit(
        "sequence",
        encode({
          op: "pointer",
          version: 1,
          id: 1,
          generation: 1,
          phase: 0.75,
          x: 4,
          y: 3,
          modifiers: 0,
          action: "down",
          button: 0,
          buttons: 1,
        }),
      );
      expect(observed).toEqual([{ origin: scoped ? 0 : undefined, x: 4, y: 3, position: 2.75 }]);
      expect(inputOrigin).toBeUndefined();
    } finally {
      controller?.dispose();
      Renderable.renderablesByNumber.delete(id);
    }
  }
});

test("painter snapshots retain captured owner hits and pass-local geometry", () => {
  const frame = fixture();
  const parent = { num: 9, parent: null };
  const owner = {
    num: 42,
    x: 2,
    y: 3,
    screenX: 2,
    screenY: 3,
    width: 9,
    height: 4,
    parent,
  } as unknown as Renderable;
  Object.assign(frame.viewport, {
    owner,
    input: (_origin: number, dispatch: () => boolean) => dispatch(),
  });
  const map: RenderHitMap = {
    width: 20,
    height: 10,
    frameId: 1,
    passId: 1,
    hitTest: (x) => (x === 3 ? 9 : x === 4 ? 77 : x === 5 ? 43 : 0),
    origin: () => undefined,
  };
  const snapshot = painterHitMap(frame.viewport, map);
  expect(snapshot.hitTest(6, 4)).toBe(42);
  expect(snapshot.hitTest(3, 4)).toBe(42);
  expect(snapshot.hitTest(4, 4)).toBe(77);
  expect(snapshot.hitTest(5, 4)).toBe(43);
  // The last painted column is fixed chrome, outside the translated content rect.
  expect(snapshot.hitTest(10, 4)).toBe(42);
  expect(snapshot.hitTest(11, 4)).toBe(0);
  expect(snapshot.hitTest(6, 7)).toBe(0);
  expect(snapshot.hitTest(NaN, 4)).toBe(0);
  expect(snapshot.origin(42)).toEqual({ x: 2, y: 3 });
  const plan = planPixelFrame(frame);
  plan.onHitMap?.(map);
  Object.assign(owner, { y: 2, screenY: 2 });
  plan.projection?.onHitMap?.(map);
  Object.assign(owner, { y: 8, screenY: 8 });
  expect(frame.snapshot?.origin(42)).toEqual({ x: 2, y: 3 });
  expect(frame.projection?.origin(42)).toEqual({ x: 2, y: 2 });
  expect(frame.snapshot?.hitTest(6, 4)).toBe(42);
  expect(frame.snapshot?.hitTest(10, 4)).toBe(42);
  expect(frame.projection?.hitTest(10, 4)).toBe(42);
  expect(frame.projection?.hitTest(10, 6)).toBe(42);
  expect(map.hitTest(6, 4)).toBe(0);
  Object.assign(owner, { screenY: 3, width: 30 });
  const terminalClipped = painterHitMap(frame.viewport, map);
  expect(terminalClipped.hitTest(19, 4)).toBe(42);
  expect(terminalClipped.hitTest(20, 4)).toBe(0);
  Object.assign(parent, {
    scrollableViewport: {
      position: 0,
      origin: 0,
      max: 0,
      rect: { x: 3, y: 3, width: 7, height: 3 },
      set() {},
      scroll: (delta: number) => delta,
      project: (origin: number) => frame.viewport.project(origin),
    },
  });
  const ancestorClipped = painterHitMap(frame.viewport, map);
  expect(ancestorClipped.hitTest(6, 4)).toBe(42);
  expect(ancestorClipped.hitTest(2, 4)).toBe(0);
  expect(ancestorClipped.hitTest(10, 4)).toBe(0);
  expect(ancestorClipped.hitTest(6, 6)).toBe(0);
  const plain = fixture().viewport;
  expect(painterHitMap(plain, map, frame.rect)).toBe(map);
});

test("v2 history keeps the presented map and all in-flight generations until acknowledgement", () => {
  const history = new PixelHistory();
  history.presentations = true;
  const frames = Array.from({ length: RETAINED_GENERATIONS }, (_, i) => ({
    ...fixture(),
    generation: i + 1,
  }));
  for (const frame of frames) history.add(frame);
  expect(history.canPublish()).toBe(false);
  expect(history.get(1, 1)).toBe(frames[0]);
  // Input does not retire v2 maps; only the ordered presentation report does.
  expect(history.get(1, 8)).toBe(frames[7]);
  expect(history.get(1, 1)).toBe(frames[0]);
  expect(history.acknowledge(2, 8)).toBe(false);
  expect(history.acknowledge(1, 9)).toBe(false);
  expect(history.canPublish()).toBe(false);
  expect(() => history.add({ ...fixture(), generation: 9 })).toThrow("window is full");
  expect(history.acknowledge(1, 6)).toBe(true);
  expect(history.get(1, 1)).toBeUndefined();
  expect(history.get(1, 6)).toBe(frames[5]);
  expect(history.get(1, 8)).toBe(frames[7]);
  expect(history.acknowledge(1, 6)).toBe(false);
  expect(history.acknowledge(1, 5)).toBe(false);
  expect(history.canPublish(5)).toBe(true);
  expect(history.canPublish(6)).toBe(false);
  history.clear();
  expect(history.canPublish(8)).toBe(true);
  expect(history.acknowledge(1, 8)).toBe(false);
});

test("v2 discovery preserves the negotiated version and revokes both versions by nonce", () => {
  const discovery = new PixelDiscovery();
  const queries = messages(new TextEncoder().encode(discovery.query()));
  const first = queries[0];
  if (first?.op !== "query") throw new Error("Missing query");
  expect(queries).toEqual([first, { ...first, version: 2 }]);
  const capability = (version: 1 | 2, reason: "ready" | "invalidated" = "ready") =>
    encode({
      op: "capability",
      version,
      nonce: first.nonce,
      reason,
      snapshot: reason === "ready",
      precise: reason === "ready",
    });
  discovery.receive(capability(1));
  expect(discovery.ready).toBe(true);
  expect(discovery.presentations).toBe(false);
  discovery.receive(capability(2));
  expect(discovery.presentations).toBe(true);
  discovery.receive(capability(1));
  expect(discovery.presentations).toBe(true);
  discovery.receive(capability(1, "invalidated"));
  expect(discovery.ready).toBe(false);
  expect(discovery.presentations).toBe(false);
  expect(discovery.receive(capability(2))).toBeUndefined();
  discovery.query();
  expect(discovery.presentations).toBe(false);
  expect(discovery.receive(capability(2))).toBeUndefined();
});

// Exercise publication through the renderer seams, without reaching into controller state.
function windowController(version: 1 | 2 = 2) {
  const osc = new EventEmitter();
  let factory: (() => RenderFramePlan | null) | null = null;
  let requests = 0;
  const cells = new Uint32Array([1]);
  const owners = [30_000, 30_001].map(
    (num) =>
      ({
        num,
        visible: true,
        isDestroyed: false,
        parent: null,
        getChildren: () => [],
      }) as unknown as Renderable,
  );
  const positions = [0.75, 0];
  const views = owners.map((owner, i): ScrollableViewport => ({
    owner,
    get position() {
      return positions[i] ?? 0;
    },
    get origin() {
      return Math.floor(positions[i] ?? 0);
    },
    max: 100,
    rect: { x: i * 10, y: 0, width: 10, height: 10 },
    set: (value) => {
      positions[i] = value;
    },
    scroll: (delta) => {
      positions[i] = (positions[i] ?? 0) + delta;
      return 0;
    },
    project: (origin) => ({ renderable: owner, translateX: 0, translateY: -origin }),
  }));
  for (const [i, owner] of owners.entries()) {
    Object.assign(owner, { scrollableViewport: views[i] });
    Renderable.renderablesByNumber.set(owner.num, owner);
  }
  const map: RenderHitMap = {
    width: 20,
    height: 10,
    frameId: 1,
    passId: 1,
    hitTest: (x) => owners[x < 10 ? 0 : 1]?.num ?? 0,
    origin: () => ({ x: 0, y: 0 }),
  };
  const observed: unknown[] = [];
  const renderer = Object.assign(new EventEmitter(), {
    root: { visible: true, getChildren: () => owners },
    width: 20,
    height: 10,
    currentFocusedRenderable: owners[0],
    keyInput: new EventEmitter(),
    nextRenderBuffer: {
      withBuffers: (
        read: (access: {
          char: Uint32Array;
          fg: Uint16Array;
          bg: Uint16Array;
          attributes: Uint32Array;
        }) => boolean,
      ) =>
        read({
          char: cells,
          fg: new Uint16Array(),
          bg: new Uint16Array(),
          attributes: new Uint32Array(),
        }),
    },
    requestRender: () => {
      requests++;
    },
    captureHitMap: () => map,
    setFramePlan: (value: typeof factory) => {
      factory = value;
    },
    dispatchMouseEventFromHitMap: (event: {
      type: string;
      x: number;
      scroll?: { delta: number };
    }) => {
      observed.push(event);
      if (event.type === "scroll") views[event.x < 10 ? 0 : 1]?.scroll(event.scroll?.delta ?? 0);
      return true;
    },
    subscribeOsc: (receive: (sequence: string) => void) => {
      osc.on("sequence", receive);
      return () => {
        osc.off("sequence", receive);
      };
    },
  });
  const writes: string[] = [];
  const controller = PixelController.attach(renderer as unknown as CliRenderer, (wire) =>
    writes.push(wire),
  );
  const query = discoveryQuery(writes[0] ?? "");
  if (!controller || query?.op !== "query") throw new Error("Missing controller query");
  const send = (message: Parameters<typeof encode>[0]) => osc.emit("sequence", encode(message));
  send({
    op: "capability",
    version,
    nonce: query.nonce,
    reason: "ready",
    snapshot: true,
    precise: true,
  });
  const plan = () => {
    const result = factory?.();
    result?.onHitMap?.(map);
    result?.projection?.onHitMap?.(map);
    return result;
  };
  return {
    plan,
    send,
    writes,
    observed,
    positions,
    cells,
    requests: () => requests,
    projecting: (value: boolean) => {
      Object.assign(renderer, { isFramePlanPass: value });
      if (!value) renderer.emit("frame:plan:end");
    },
    close: () => {
      controller.dispose();
      for (const owner of owners) Renderable.renderablesByNumber.delete(owner.num);
    },
  };
}

test("full v2 publication window coalesces current state and never blocks input", () => {
  const f = windowController();
  try {
    for (let i = 0; i < RETAINED_GENERATIONS; i++) {
      f.cells[0] = i + 1;
      expect(messages(f.plan()?.before)[0]).toMatchObject({ op: "begin", generation: i + 1 });
    }
    f.positions[0] = 5.25;
    f.cells[0] = 99;
    expect(f.plan()).toEqual({ deferHover: true });
    f.send({
      op: "pointer",
      version: 1,
      id: 1,
      generation: 1,
      phase: 0.75,
      x: 4,
      y: 3,
      modifiers: 0,
      action: "down",
      button: 0,
      buttons: 1,
    });
    expect(f.observed).toHaveLength(1);
    f.send({
      op: "wheel",
      version: 1,
      id: 1,
      generation: 1,
      phase: 0.75,
      x: 4,
      y: 3,
      modifiers: 0,
      dx: 0,
      dy: 0.5,
      source: "precise",
    });
    expect(f.observed).toHaveLength(2);
    expect(f.positions[0]).toBe(5.75);
    const requests = f.requests();
    f.send({ op: "presented", version: 2, id: 2, generation: 8 });
    f.send({ op: "presented", version: 2, id: 1, generation: 9 });
    expect(f.requests()).toBe(requests);
    expect(f.plan()).toEqual({ deferHover: true });
    f.send({ op: "presented", version: 2, id: 1, generation: 8 });
    expect(f.requests()).toBe(requests + 1);
    const latest = f.plan();
    expect(messages(latest?.before)[0]).toMatchObject({ generation: 9 });
    expect(messages(latest?.after)[0]).toMatchObject({ origin: 5 });
    expect(messages(latest?.projection?.after)[0]).toMatchObject({ fraction: 0.75 });
    expect(f.plan()).toEqual({ deferHover: true });
    f.send({ op: "presented", version: 2, id: 1, generation: 8 });
    expect(f.requests()).toBe(requests + 1);
  } finally {
    f.close();
  }
});

test("a v2 handover reserves both generations and retains its intermediate release", () => {
  const f = windowController();
  try {
    for (let i = 0; i < RETAINED_GENERATIONS - 1; i++) {
      f.cells[0] = i + 1;
      f.plan();
    }
    f.send({
      op: "wheel",
      version: 1,
      id: 1,
      generation: 1,
      phase: 0.75,
      x: 12,
      y: 3,
      modifiers: 0,
      dx: 0,
      dy: 0.25,
      source: "precise",
    });
    expect(f.plan()).toEqual({ deferHover: true });
    f.send({ op: "presented", version: 2, id: 1, generation: 7 });
    const handover = f.plan();
    const all = [
      ...messages(handover?.before),
      ...messages(handover?.after),
      ...messages(handover?.projection?.after),
    ];
    expect(all.filter((message) => message?.op === "begin")).toMatchObject([
      { generation: 8 },
      { generation: 9 },
    ]);
    expect(all.filter((message) => message?.op === "release")).toMatchObject([{ generation: 8 }]);
    f.send({ op: "presented", version: 2, id: 1, generation: 8 });
    const count = f.observed.length;
    f.send({
      op: "pointer",
      version: 1,
      id: 1,
      generation: 8,
      phase: 0,
      x: 4,
      y: 3,
      modifiers: 0,
      action: "down",
      button: 0,
      buttons: 1,
    });
    expect(f.observed).toHaveLength(count + 1);
  } finally {
    f.close();
  }
});

test("a v2 app with a v1 host keeps the original eviction behavior", () => {
  const f = windowController(1);
  try {
    for (let i = 0; i <= RETAINED_GENERATIONS; i++) {
      f.cells[0] = i + 1;
      expect(messages(f.plan()?.before)[0]).toMatchObject({ generation: i + 1 });
    }
    f.send({
      op: "pointer",
      version: 1,
      id: 1,
      generation: 1,
      phase: 0.75,
      x: 4,
      y: 3,
      modifiers: 0,
      action: "down",
      button: 0,
      buttons: 1,
    });
    expect(f.observed).toHaveLength(0);
    f.send({
      op: "pointer",
      version: 1,
      id: 1,
      generation: 9,
      phase: 0.75,
      x: 4,
      y: 3,
      modifiers: 0,
      action: "down",
      button: 0,
      buttons: 1,
    });
    expect(f.observed).toHaveLength(1);
  } finally {
    f.close();
  }
});

test("presentation acknowledgements stay out of generation-free input replay", () => {
  expect(
    new OrdinaryPixelInput().convert(encode({ op: "presented", version: 2, id: 1, generation: 8 })),
  ).toBe("");
});

test("invalidation abandons a full v2 window and renegotiates without reusing generations", async () => {
  const f = windowController();
  try {
    for (let i = 0; i < RETAINED_GENERATIONS; i++) {
      f.cells[0] = i + 1;
      f.plan();
    }
    expect(f.plan()).toEqual({ deferHover: true });
    const oldQuery = discoveryQuery(f.writes[0] ?? "");
    if (oldQuery?.op !== "query") throw new Error("Missing original query");
    f.send({
      op: "capability",
      version: 2,
      nonce: oldQuery.nonce,
      snapshot: false,
      precise: false,
      reason: "invalidated",
    });
    expect(f.writes.at(-1)).toEndWith("l");
    expect(f.plan()).toBeNull();
    await Promise.resolve();
    const freshQuery = discoveryQuery(f.writes.at(-1) ?? "");
    if (freshQuery?.op !== "query") throw new Error("Missing fresh query");
    expect(freshQuery.nonce).not.toBe(oldQuery.nonce);
    f.send({
      op: "capability",
      version: 2,
      nonce: oldQuery.nonce,
      snapshot: true,
      precise: true,
      reason: "ready",
    });
    expect(f.plan()).toBeNull();
    f.send({
      op: "capability",
      version: 2,
      nonce: freshQuery.nonce,
      snapshot: true,
      precise: true,
      reason: "ready",
    });
    const requests = f.requests();
    f.send({ op: "presented", version: 2, id: 1, generation: 8 });
    expect(f.requests()).toBe(requests);
    const recovered = f.plan();
    expect(messages(recovered?.before)[0]).toMatchObject({ generation: 9 });
    expect(messages(recovered?.projection?.after)[0]).toMatchObject({ fraction: 0.75 });
  } finally {
    f.close();
  }
});

test("private input waits only for planned paint, then resumes before sink delivery", () => {
  const f = windowController();
  try {
    f.plan();
    f.projecting(true);
    f.send({
      op: "wheel",
      version: 1,
      id: 1,
      generation: 1,
      phase: 0.75,
      x: 4,
      y: 3,
      modifiers: 0,
      dx: 0,
      dy: 0.5,
      source: "precise",
    });
    f.send({
      op: "pointer",
      version: 1,
      id: 1,
      generation: 1,
      phase: 0.75,
      x: 4,
      y: 3,
      modifiers: 0,
      action: "down",
      button: 0,
      buttons: 1,
    });
    expect(f.positions[0]).toBe(0.75);
    expect(f.observed).toEqual([]);
    f.projecting(false);
    expect(f.positions[0]).toBe(1.25);
    expect(f.observed).toMatchObject([{ type: "scroll" }, { type: "down" }]);
  } finally {
    f.close();
  }
});
