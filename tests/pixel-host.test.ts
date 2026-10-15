import { expect, test } from "bun:test";
import type { Terminal } from "@xterm/xterm";
import { decode, MODE, NS } from "../packages/core/src/pixel-scroll/protocol";
import { PixelScrollAddon } from "../packages/core/src/web/pixel-scroll/host";
import type { PixelOperation, PixelReport } from "../packages/core/src/pixel-scroll/protocol";
import type {
  PixelRenderer,
  Presentation,
} from "../packages/core/src/web/pixel-scroll/presentation";
import { PixelSession } from "../packages/core/src/web/pixel-scroll/session";

function fixture(
  reason: Extract<PixelReport, { op: "capability" }>["reason"] = "ready",
  gpu = true,
) {
  const reports: PixelReport[] = [];
  let captured = 0;
  let committed: Presentation | undefined;
  let released = 0;
  const renderer: PixelRenderer = {
    cellHeight: 10,
    begin() {},
    capture() {
      captured++;
    },
    commit(p) {
      committed = p;
    },
    release() {
      released++;
      return true;
    },
    abort() {},
    invalidate() {},
    onPresent() {
      return { dispose() {} };
    },
    onInvalidate() {
      return { dispose() {} };
    },
  };
  const session = new PixelSession(
    gpu ? renderer : undefined,
    () => ({ cols: 80, rows: 24 }),
    () => reason,
    (report) => reports.push(report),
  );
  const send = (operation: PixelOperation) => session.operation(operation);
  const query = (nonce = "test") => send({ op: "query", version: 1, nonce });
  const begin = (generation = 1) => send({ op: "begin", version: 1, generation });
  const register = (generation = 1, id = 1, width = 20) =>
    send({
      op: "register",
      version: 1,
      generation,
      id,
      rect: { x: 2, y: 3, width, height: 8 },
      origin: 12,
    });
  const step = (generation = 1, fraction = 0.3) =>
    send({ op: "step", version: 1, generation, id: 1, fraction });
  const commit = (generation = 1) => send({ op: "commit", version: 1, generation });
  const frame = (generation = 1, fraction = 0.3) => {
    begin(generation);
    register(generation);
    step(generation, fraction);
    commit(generation);
  };
  query();
  return {
    session,
    renderer,
    reports,
    send,
    query,
    begin,
    register,
    step,
    commit,
    frame,
    captured: () => captured,
    committed: () => committed,
    released: () => released,
  };
}

test("discovery replies ready only with both capabilities and a renderer", () => {
  for (const reason of [
    "ready",
    "reduced-motion",
    "screen-reader",
    "no-gpu",
    "disabled",
    "invalidated",
  ] as const) {
    const f = fixture(reason);
    expect(f.reports).toEqual([
      {
        op: "capability",
        version: 1,
        nonce: "test",
        reason,
        snapshot: reason === "ready",
        precise: reason === "ready",
      },
    ]);
    if (reason !== "ready") {
      f.frame();
      expect(f.committed()).toBeUndefined();
    }
  }
  expect(fixture("ready", false).reports[0]).toMatchObject({
    reason: "no-gpu",
    snapshot: false,
    precise: false,
  });
});

test("revocation is terminal for its nonce, stops inputs, and keeps generation high water", () => {
  const f = fixture();
  f.frame(10);
  f.session.present(f.committed());
  f.session.inputMode = true;
  f.session.invalidate("no-gpu");
  expect(f.session.presented).toBeUndefined();
  expect(f.session.inputMode).toBe(false);
  f.query();
  expect(f.reports.at(-1)).toMatchObject({ reason: "invalidated" });
  f.query("new");
  f.frame(9);
  expect(f.committed()?.generation).toBe(10);
  f.frame(11);
  expect(f.committed()?.generation).toBe(11);
});

test("input mode reports the presented generation while commits and begins remain unpresented", () => {
  const f = fixture();
  const wheel = {
    op: "wheel",
    x: 3.2,
    y: 5.1,
    modifiers: 5,
    dx: 0.1,
    dy: -0.3,
    source: "precise",
  } as const;
  expect(f.session.input(wheel)).toBe(false);
  f.frame();
  expect(f.session.presented).toBeUndefined();
  f.session.present(f.committed());
  expect(f.session.input(wheel)).toBe(false);
  f.session.inputMode = true;
  f.frame(2, 0.01);
  f.begin(3);
  expect(f.session.input(wheel)).toBe(true);
  expect(f.reports.at(-1)).toMatchObject({ generation: 1, phase: 0.3, dy: -0.3 });
  expect(
    f.session.input({
      op: "pointer",
      action: "down",
      button: 0,
      buttons: 1,
      modifiers: 1,
      x: 3.2,
      y: 5.1,
    }),
  ).toBe(true);
  expect(f.reports.at(-1)).toMatchObject({ generation: 1, phase: 0.3, action: "down" });
  f.session.present(f.committed());
  f.session.input(wheel);
  expect(f.reports.at(-1)).toMatchObject({ generation: 2, phase: 0 });
  f.session.inputMode = false;
  expect(f.session.input(wheel)).toBe(false);
});

test("stale steps, duplicates, wrong ids and missing stages invalidate the preparation", () => {
  for (const breakFrame of [
    (f: ReturnType<typeof fixture>) => f.step(1),
    (f: ReturnType<typeof fixture>) => f.register(2),
    (f: ReturnType<typeof fixture>) =>
      f.send({ op: "step", version: 1, generation: 2, id: 2, fraction: 0.5 }),
  ]) {
    const f = fixture();
    f.frame();
    f.session.present(f.committed());
    f.begin(2);
    f.register(2);
    breakFrame(f);
    f.step(2);
    f.commit(2);
    expect(f.committed()?.generation).toBe(1);
    expect(f.session.presented?.generation).toBe(1);
  }
  const f = fixture();
  f.begin();
  f.commit();
  expect(f.committed()).toBeUndefined();
  f.frame(2);
  f.begin(2);
  f.register(2);
  f.step(2);
  f.commit(2);
  expect(f.captured()).toBe(1);
});

test("rejects out-of-grid regions and switching surfaces without a release", () => {
  const f = fixture();
  f.begin();
  f.register(1, 1, 80);
  f.step();
  f.commit();
  expect(f.captured()).toBe(0);
  f.frame(2);
  f.begin(3);
  f.register(3, 2);
  f.step(3);
  f.commit(3);
  expect(f.committed()?.generation).toBe(2);
});

test("release requires matching canonical generation, including positive fractions rounded to zero", () => {
  const f = fixture();
  f.frame(1, 0.01);
  f.send({ op: "release", version: 1, id: 1, generation: 1 });
  expect(f.released()).toBe(0);
  f.frame(2, 0);
  f.send({ op: "release", version: 1, id: 1, generation: 1 });
  expect(f.released()).toBe(0);
  f.send({ op: "release", version: 1, id: 1, generation: 2 });
  expect(f.released()).toBe(1);
});

test("a release inside a preparation rejects the entire preparation", () => {
  const f = fixture();
  f.frame();
  f.begin(2);
  f.register(2);
  f.step(2);
  f.send({ op: "release", version: 1, id: 1, generation: 1 });
  f.commit(2);
  expect(f.committed()?.generation).toBe(1);
  expect(f.released()).toBe(0);
});

test("an outside-grid mouseup ends a drag without capturing later chrome input", () => {
  const f = fixture();
  f.frame();
  let present: ((p: Presentation | undefined) => void) | undefined;
  f.renderer.onPresent = (listener) => {
    present = listener;
    return { dispose() {} };
  };
  const listeners = new Map<string, (event: MouseEvent) => void>();
  const reports: unknown[] = [];
  let osc: ((payload: string) => boolean | Promise<boolean>) | undefined;
  let csi: ((params: number[]) => boolean | Promise<boolean>) | undefined;
  const dispose = () => ({ dispose() {} });
  class TestNode {}
  const target = new TestNode();
  const globals = ["Node", "matchMedia"] as const;
  const previous = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, "Node", { configurable: true, value: TestNode });
  Object.defineProperty(globalThis, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  const terminal = {
    cols: 80,
    rows: 24,
    options: {},
    input: (sequence: string) => reports.push(decode(sequence)),
    onResize: dispose,
    buffer: { onBufferChange: dispose },
    parser: {
      registerEscHandler: dispose,
      registerOscHandler: (_id: number, listener: typeof osc) => {
        osc = listener;
        return dispose();
      },
      registerCsiHandler: (id: { final: string }, listener: typeof csi) => {
        if (id.final === "h") csi = listener;
        return dispose();
      },
    },
    element: {
      contains: (node: unknown) => node === target,
      querySelector: (selector: string) =>
        selector === ".xterm-screen"
          ? { getBoundingClientRect: () => ({ left: 0, top: 0, width: 80, height: 24 }) }
          : undefined,
      ownerDocument: {
        addEventListener: (type: string, listener: (event: MouseEvent) => void) =>
          listeners.set(type, listener),
        removeEventListener() {},
      },
    },
  };
  const addon = new PixelScrollAddon(f.renderer);
  try {
    // eslint-disable-next-line typescript/consistent-type-assertions -- Minimal terminal port for document-level input, without a browser DOM.
    addon.activate(terminal as unknown as Terminal);
    void csi?.([2026, MODE]);
    void osc?.(`${NS};${JSON.stringify({ op: "query", version: 1, nonce: "drag" })}`);
    present?.(f.committed());
    reports.length = 0;
    const pointer = (type: string, x: number, buttons: number) => {
      let prevented = false;
      // eslint-disable-next-line typescript/consistent-type-assertions -- Only the mouse fields consumed by the registered input listener are needed.
      listeners.get(type)?.({
        type,
        target,
        clientX: x,
        clientY: 5,
        buttons,
        button: 0,
        preventDefault() {
          prevented = true;
        },
        stopImmediatePropagation() {},
      } as unknown as MouseEvent);
      return prevented;
    };
    expect(pointer("mousedown", 3, 1)).toBe(true);
    expect(pointer("mousemove", 25, 1)).toBe(true); // Drag across chrome.
    expect(reports).toMatchObject([{ action: "down" }, { action: "drag" }]);
    expect(pointer("mouseup", 81, 0)).toBe(false); // Release outside the grid.
    expect(pointer("mousemove", 25, 0)).toBe(false);
    expect(pointer("mousedown", 25, 1)).toBe(false);
    expect(reports).toHaveLength(2);
    expect(pointer("mousedown", 3, 1)).toBe(true); // A new surface gesture still works.
    expect(pointer("mouseup", 3, 0)).toBe(true);
    expect(reports).toMatchObject([
      { action: "down" },
      { action: "drag" },
      { action: "down" },
      { action: "up" },
    ]);
  } finally {
    addon.dispose();
    globals.forEach((name, index) => {
      const descriptor = previous[index];
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});
