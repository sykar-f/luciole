// Bundled by opentui-seams.test.ts against the patched TypeScript and WASM sources.
import { expect, test } from "bun:test";
import { createTestStdout } from "../node_modules/@opentui/core/testing/test-streams";
import {
  CliRenderEvents,
  BoxRenderable,
  TextRenderable,
  type CliRendererErrorEvent,
  MouseEvent,
  type RawMouseEvent,
} from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { detectOpenTuiSeams, type RenderHitMap } from "../packages/core/src/web/opentui-seams";
import baseline from "./fixtures/opentui-seams/plain-frame.json";

const bytes = (s: string) => new TextEncoder().encode(s);
const start = "\x1b[?2026h",
  end = "\x1b[?2026l";
const modifiers = { shift: false, alt: false, ctrl: false, meta: true };
async function setup(width = 12, height = 4) {
  const chunks: string[] = [];
  const stdout = createTestStdout(width, height);
  stdout._write = (chunk: Buffer, _encoding, done) => {
    chunks.push(chunk.toString());
    done();
  };
  const setup = await createTestRenderer({
    width,
    height,
    stdout,
    bufferedOutput: "stdout",
    useMouse: true,
    useThread: false,
  });
  const found = detectOpenTuiSeams(setup.renderer);
  if (!found.available) throw new Error(`Missing seams: ${found.missing.join(", ")}`);
  return { ...setup, r: found.renderer, chunks };
}

test("no plan and an empty single-commit plan preserve pinned OpenTUI bytes, including no-op suppression", async () => {
  for (const planned of [false, true]) {
    const { r, renderOnce, chunks } = await setup(8, 2);
    try {
      r.root.add(new TextRenderable(r, { content: "BASE", width: 8, height: 1 }));
      if (planned) r.setFramePlan(() => ({}));
      await renderOnce();
      await r.idle();
      expect(chunks).toEqual(baseline);
      chunks.length = 0;
      await renderOnce();
      await r.idle();
      expect(chunks).toEqual([]);
    } finally {
      r.destroy();
    }
  }
});

async function scene(selectable = false) {
  const fixture = await setup();
  const { r } = fixture;
  const counters = { updates: 0, lifecycle: 0, before: 0, after: 0 };
  class Content extends BoxRenderable {
    protected override onUpdate() {
      counters.updates++;
    }
  }
  const view = new BoxRenderable(r, { id: "clip", width: 12, height: 2, overflow: "hidden" });
  const content = new Content(r, { id: "content", width: 12, height: 4, flexShrink: 0 });
  content.onLifecyclePass = () => {
    counters.lifecycle++;
  };
  r.registerLifecyclePass(content);
  content.renderBefore = () => {
    counters.before++;
  };
  content.renderAfter = () => {
    counters.after++;
  };
  const rows = ["AAAA", "BBBB", "CCCC", "DDDD"].map(
    (text, i) =>
      new TextRenderable(r, { id: `row${i}`, content: text, height: 1, width: 12, selectable }),
  );
  r.root.add(view);
  view.add(content);
  rows.forEach((row) => content.add(row));
  let normal: RenderHitMap | undefined, projected: RenderHitMap | undefined;
  let logicalPasses = 0;
  r.setFramePlan(() => {
    logicalPasses++;
    return {
      before: bytes("<begin>"),
      after: bytes("<register>"),
      onHitMap: (map) => {
        normal = map;
      },
      projection: {
        renderable: content,
        translateX: 0,
        translateY: -1,
        before: bytes("<project>"),
        after: bytes("<commit>"),
        onHitMap: (map) => {
          expect(content.translateY).toBe(0);
          content.requestRender();
          r.requestRender();
          projected = map;
        },
      },
    };
  });
  await fixture.renderOnce();
  await r.idle();
  if (!normal || !projected) throw new Error("Paint maps were not captured");
  return { ...fixture, rows, content, view, counters, normal, projected, logicalPasses };
}

test("ordered normal and projected segments use one envelope and distinct paint identities without logical updates", async () => {
  const { r, chunks, rows, content, view, counters, normal, projected, logicalPasses } =
    await scene();
  try {
    expect(chunks.length).toBeGreaterThan(0);
    for (const wire of chunks) {
      expect(wire.split(start)).toHaveLength(2);
      expect(wire.split(end)).toHaveLength(2);
      const positions = [
        start,
        "<begin>",
        "AAAA",
        "<register>",
        "<project>",
        "CCCC",
        "<commit>",
        end,
      ].map((s) => wire.indexOf(s));
      expect(
        positions.every((pos, i) => pos >= 0 && (i === 0 || pos > (positions[i - 1] ?? -1))),
      ).toBe(true);
    }
    expect(normal.frameId).toBe(projected.frameId);
    expect(normal.passId).not.toBe(projected.passId);
    expect(normal.hitTest(0.2, 0.8)).toBe(rows[0]?.num);
    expect(projected.hitTest(0.2, 0.8)).toBe(rows[1]?.num);
    expect(projected.hitTest(0, 1)).toBe(rows[2]?.num); // entering edge, previously culled
    expect(projected.hitTest(0, 2)).not.toBe(rows[3]?.num); // viewport clips
    expect(projected.hitTest(-0.1, 0)).toBe(0);
    expect(projected.hitTest(Infinity, 0)).toBe(0);
    expect(projected.origin(rows[1]?.num)).toEqual({ x: 0, y: 0 });
    expect(rows[1]?.y).toBe(1);
    expect(content.translateY).toBe(0);
    expect(view.height).toBe(2);
    expect(counters).toEqual({
      updates: logicalPasses,
      lifecycle: logicalPasses,
      before: logicalPasses,
      after: logicalPasses,
    });
    const frameId = r.frameId;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await r.idle();
    expect(r.frameId).toBe(frameId);
  } finally {
    r.destroy();
  }
});

test("the next frame diffs against the last projected cells", async () => {
  const { r, chunks, content, renderOnce } = await scene();
  try {
    r.setFramePlan(null);
    chunks.length = 0;
    content.translateY = -1; // logical state catches up to the already committed projection
    await renderOnce();
    await r.idle();
    expect(chunks).toEqual([]);
    content.translateY = 0;
    await renderOnce();
    await r.idle();
    expect(chunks.join("")).toContain("AAAA");
  } finally {
    r.destroy();
  }
});

function input(type: RawMouseEvent["type"], x = 0.25, y = 0.5): RawMouseEvent {
  return {
    type,
    button: 0,
    x,
    y,
    modifiers,
    ...(type === "scroll" ? { scroll: { direction: "down" as const, delta: 0.375 } } : {}),
  };
}

test("captured hits drive ordinary hover, capture, drag-end and drop with precise coordinates and modifiers", async () => {
  const { r, rows, normal, projected } = await scene();
  try {
    const received: {
      id: string;
      type: string;
      x: number;
      y: number;
      modifiers: unknown;
      scroll: unknown;
      source: string | undefined;
    }[] = [];
    for (const row of rows)
      row.onMouse = (event: MouseEvent) => {
        received.push({
          id: row.id,
          type: event.type,
          x: event.x,
          y: event.y,
          modifiers: event.modifiers,
          scroll: event.scroll,
          source: event.source?.id,
        });
      };
    const event = input("move");
    r.dispatchMouseEventFromHitMap(event, normal);
    expect(received.some((e) => e.id === "row0" && e.type === "over")).toBe(true);
    r.dispatchMouseEventFromHitMap(input("move"), projected);
    expect(received.some((e) => e.id === "row0" && e.type === "out")).toBe(true);
    expect(received.find((e) => e.id === "row1" && e.type === "move")).toMatchObject({
      x: 0.25,
      y: 1.5,
      modifiers,
    });
    expect(event).toEqual(input("move")); // dispatch does not mutate the caller's event
    r.dispatchMouseEventFromHitMap(input("down"), normal);
    r.dispatchMouseEventFromHitMap(input("drag"), normal);
    received.length = 0;
    r.dispatchMouseEventFromHitMap(input("drag"), projected);
    expect(received.some((e) => e.id === "row0" && e.type === "drag")).toBe(true);
    r.dispatchMouseEventFromHitMap(input("up"), projected);
    expect(received.some((e) => e.id === "row0" && e.type === "drag-end")).toBe(true);
    expect(received.some((e) => e.id === "row1" && e.type === "drop" && e.source === "row0")).toBe(
      true,
    );
    r.dispatchMouseEventFromHitMap(input("scroll"), projected);
    expect(received.find((e) => e.id === "row1" && e.type === "scroll")?.scroll).toEqual({
      direction: "down",
      delta: 0.375,
    });
    rows[0]?.destroy();
    received.length = 0;
    r.dispatchMouseEventFromHitMap(input("down"), normal);
    expect(received).toEqual([]);
  } finally {
    r.destroy();
  }
});

test("selection uses the normal selection machine and captured paint coordinates", async () => {
  const { r, projected } = await scene(true);
  try {
    r.dispatchMouseEventFromHitMap(input("down", 0.25), projected);
    r.dispatchMouseEventFromHitMap(input("drag", 3.75), projected);
    r.dispatchMouseEventFromHitMap(input("up", 3.75), projected);
    expect(r.getSelection()?.getSelectedText()).toContain("BBB");
    expect(r.getSelection()?.isDragging).toBe(false);
  } finally {
    r.destroy();
  }
});

test("an abandoned projection restores geometry and discards its entire encoder transaction", async () => {
  const { r, chunks, content, rows, renderOnce } = await scene();
  try {
    const errors: string[] = [];
    r.on(CliRenderEvents.RENDER_ERROR, (event: CliRendererErrorEvent) => {
      errors.push(event.error.message);
    });
    chunks.length = 0;
    r.setFramePlan(() => ({
      before: bytes("<abandoned>"),
      projection: {
        renderable: content,
        translateX: 0,
        translateY: -1,
        onHitMap() {
          throw new Error("abandon projection");
        },
      },
    }));
    await renderOnce();
    await r.idle();
    expect(errors).toEqual(["abandon projection"]);
    expect(chunks).toEqual([]);
    expect(content.translateY).toBe(0);
    expect(rows[1]?.y).toBe(1);
    r.setFramePlan(null);
    await renderOnce();
    await r.idle();
    expect(chunks.join("")).toContain("AAAA");
    expect(chunks.join("")).not.toContain("<abandoned>");
    for (const wire of chunks) {
      expect(wire.split(start)).toHaveLength(2);
      expect(wire.split(end)).toHaveLength(2);
    }
  } finally {
    r.destroy();
  }
});

async function scrollScene() {
  const fixture = await setup(30, 16);
  const { ScrollBoxRenderable } = await import("@opentui/core");
  const parent = new ScrollBoxRenderable(fixture.r, {
    width: 24,
    height: 12,
    scrollY: true,
    scrollX: true,
    contentOptions: { width: 40 },
  });
  const child = new ScrollBoxRenderable(fixture.r, {
    width: 18,
    height: 6,
    flexShrink: 0,
    scrollY: true,
  });
  child.add(
    new TextRenderable(fixture.r, {
      content: Array.from({ length: 12 }, (_, i) => `child ${i}`).join("\n"),
      height: 12,
      flexShrink: 0,
    }),
  );
  parent.add(child);
  parent.add(new TextRenderable(fixture.r, { content: "tail", height: 20, flexShrink: 0 }));
  fixture.r.root.add(parent);
  await fixture.renderOnce();
  await fixture.renderOnce();
  const { detectScrollableViewport } = await import("../packages/core/src/web/opentui-seams");
  const outer = detectScrollableViewport(parent);
  const inner = detectScrollableViewport(child);
  if (!outer || !inner) throw new Error("Missing scrollable viewport");
  return { ...fixture, parent, child, outer, inner };
}

test("ScrollBox fractions survive keys, scrollTo, scrollbar moves and auto-scroll, and clamp on resize", async () => {
  const { r, child, inner, renderOnce, mockInput } = await scrollScene();
  try {
    inner.set(1.375);
    expect(child.scrollTop).toBe(1);
    child.scrollTo(2);
    expect(inner.position).toBe(2.375);
    child.verticalScrollBar.scrollBy(1);
    expect(inner.position).toBe(3.375);
    child.focus();
    mockInput.pressArrow("up");
    expect(inner.position).toBe(2.375);
    // The normal selection auto-scroll uses integer scrollTop increments.
    child.startAutoScroll(child.x + child.width / 2, child.y + child.height - 1);
    probe(child, "handleAutoScroll", 20);
    child.stopAutoScroll();
    expect(inner.position).toBe(3.375);
    expect(inner.origin).toBe(child.scrollTop);
    child.height = 14;
    await renderOnce();
    await renderOnce();
    expect(inner.position).toBe(inner.max);
    expect(inner.position).toBe(0);
    expect(() => inner.set(NaN)).toThrow();
  } finally {
    r.destroy();
  }
});

test("content-only ScrollBox projections preserve logical state, events and render scheduling", async () => {
  const { r, parent, outer, renderOnce } = await scrollScene();
  try {
    outer.set(1.625);
    let changes = 0;
    parent.verticalScrollBar.on("change", () => changes++);
    const before = {
      position: outer.position,
      origin: outer.origin,
      translation: parent.content.translateY,
    };
    expect(outer.rect).toEqual({
      x: parent.viewport.x,
      y: parent.viewport.y,
      width: parent.viewport.width,
      height: parent.viewport.height,
    });
    expect(outer.rect.x + outer.rect.width).toBeLessThanOrEqual(parent.verticalScrollBar.x);
    expect(outer.rect.y + outer.rect.height).toBeLessThanOrEqual(parent.horizontalScrollBar.y);
    const projection = outer.project(2);
    expect(projection.renderable).toBe(parent.content);
    expect(parent.content.translateY).toBe(before.translation);
    let projected: RenderHitMap | undefined;
    r.setFramePlan(() => ({
      projection: {
        ...projection,
        onHitMap(map) {
          projected = map;
          expect(outer.position).toBe(before.position);
          expect(outer.origin).toBe(before.origin);
        },
      },
    }));
    await renderOnce();
    await r.idle();
    expect(projected).toBeDefined();
    expect(projected?.origin(parent.verticalScrollBar.slider.num)).toEqual({
      x: parent.verticalScrollBar.slider.x,
      y: parent.verticalScrollBar.slider.y,
    });
    expect({
      position: outer.position,
      origin: outer.origin,
      translation: parent.content.translateY,
    }).toEqual(before);
    expect(changes).toBe(0);
    const frame = r.frameId;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await r.idle();
    expect(r.frameId).toBe(frame);
    expect(() => outer.project(0.5)).toThrow();
  } finally {
    r.destroy();
  }
});

test("thumb paint and hit geometry follow fractional rows on the half-cell grid", async () => {
  const { r, child, inner } = await scrollScene();
  try {
    const slider = child.verticalScrollBar.slider;
    const start = () => probe(child.verticalScrollBar.slider, "getVirtualThumbStart");
    const size = () => probe(child.verticalScrollBar.slider, "getVirtualThumbSize");
    inner.set(0);
    const a = start();
    inner.set(0.875);
    const b = start();
    expect(child.scrollTop).toBe(0);
    expect(slider.value).toBe(0);
    expect(b).toBeGreaterThan(a);
    expect(Number.isInteger(b)).toBe(true);
    expect(size()).toBe(
      Math.max(1, Math.floor((slider.height * 2 * child.viewport.height) / child.scrollHeight)),
    );
  } finally {
    r.destroy();
  }
});

test("precise row deltas bypass acceleration and bubble only the remainder; chain ownership rounds the previous surface", async () => {
  const { r, parent, child, outer, inner } = await scrollScene();
  try {
    let ticks = 0;
    for (const box of [parent, child])
      box.scrollAcceleration = {
        tick() {
          ticks++;
          return 100;
        },
        reset() {},
      };
    const precise = (delta: number) => {
      const attributes: import("../packages/core/src/web/opentui-seams").PresentedMouseEvent = {
        ...input("scroll"),
        scroll: { direction: delta < 0 ? "up" : "down", delta: Math.abs(delta), precise: true },
      };
      const event = new MouseEvent(child, attributes);
      child.processMouseEvent(event);
      return event;
    };
    precise(0.375);
    expect(inner.position).toBe(0.375);
    expect(outer.position).toBe(0);
    outer.set(1.625);
    expect(inner.position).toBe(0);
    precise(0.25);
    expect(outer.position).toBe(2);
    expect(inner.position).toBe(0.25);
    inner.set(inner.max - 0.25);
    precise(0.625);
    expect(inner.position).toBe(inner.max);
    expect(outer.position).toBe(2.375);
    precise(0.25);
    expect(inner.position).toBe(inner.max);
    expect(outer.position).toBe(2.625);
    precise(-0.5);
    expect(outer.position).toBe(3);
    expect(inner.position).toBe(inner.max - 0.5);
    expect(ticks).toBe(0);
    inner.set(0);
    outer.set(1.625);
    precise(1);
    expect(outer.position).toBe(2);
    expect(inner.position).toBe(1);
    inner.set(0);
    outer.set(0);
    const exhausted = precise(-0.25);
    expect(exhausted.propagationStopped).toBe(false);
    expect(exhausted.scroll?.delta).toBe(0.25);
    expect(inner.scroll(-0.5)).toBe(-0.5);
    // Existing discrete wheel keeps the configured acceleration and integer origin.
    child.processMouseEvent(new MouseEvent(child, input("scroll")));
    expect(ticks).toBeGreaterThan(0);
    expect(Number.isInteger(child.scrollTop)).toBe(true);
    expect(inner.position).toBe(inner.origin);
  } finally {
    r.destroy();
  }
});

test("frame commands reject synchronized-output controls in every segment before output", async () => {
  const { r, chunks, renderOnce } = await setup();
  try {
    const content = new BoxRenderable(r, { width: 10, height: 2 });
    r.root.add(content);
    await renderOnce();
    await r.idle();
    const errors: string[] = [];
    r.on(CliRenderEvents.RENDER_ERROR, (event: CliRendererErrorEvent) =>
      errors.push(event.error.message),
    );
    for (const control of [start, end, "\x9b?2026h", "\x1b[?25;2026h", "\x1b[?2026;25l"]) {
      for (const projected of [false, true])
        for (const field of ["before", "after"]) {
          chunks.length = 0;
          const command = { [field]: bytes(`prefix${control}suffix`) };
          if (control.startsWith("\x9b"))
            command[field] = new Uint8Array([0x9b, ...bytes("?2026h")]);
          r.setFramePlan(() =>
            projected
              ? {
                  before: bytes("unwritten"),
                  projection: { renderable: content, translateX: 0, translateY: -1, ...command },
                }
              : command,
          );
          await renderOnce();
          await r.idle();
          expect(errors.at(-1)).toContain("must not contain synchronized-output");
          expect(chunks).toEqual([]);
        }
    }
    expect(errors).toHaveLength(20);
    // Capture callbacks can fill mutable command buffers; validate after they run.
    for (const projected of [false, true]) {
      chunks.length = 0;
      const commands = bytes("ordinary");
      const segment = {
        before: commands,
        onHitMap() {
          commands.set(bytes(start));
        },
      };
      r.setFramePlan(() =>
        projected
          ? {
              before: bytes("unwritten"),
              projection: { renderable: content, translateX: 0, translateY: -1, ...segment },
            }
          : segment,
      );
      await renderOnce();
      await r.idle();
      expect(errors.at(-1)).toContain("must not contain synchronized-output");
      expect(chunks).toEqual([]);
    }
    expect(errors).toHaveLength(22);
    r.setFramePlan(() => ({ before: bytes("allowed") }));
    await renderOnce();
    await r.idle();
    expect(chunks.join("")).toContain("allowed");
  } finally {
    r.destroy();
  }
});

// Test probes for upstream private geometry and deterministic auto-scroll time.
function probe(value: unknown, key: string, ...args: number[]): number {
  if (typeof value !== "object" || value === null) throw new Error("Missing probe target");
  const method: unknown = Reflect.get(value, key);
  const callable = (candidate: unknown): candidate is (...args: number[]) => unknown =>
    typeof candidate === "function";
  if (!callable(method)) throw new Error(`Missing probe ${key}`);
  const result = method.apply(value, args);
  if (result === undefined) return 0;
  if (typeof result !== "number") throw new Error(`Non-numeric probe ${key}`);
  return result;
}

test("planned hover waits for presented input when deferred and keeps its default otherwise", async () => {
  for (const deferHover of [true, false]) {
    const { r, renderOnce, rows, content, normal } = await scene();
    try {
      r.setFramePlan(null);
      await renderOnce();
      await r.idle();
      const over: string[] = [];
      const out: string[] = [];
      for (const row of rows) {
        row.onMouseOver = () => over.push(row.id);
        row.onMouseOut = () => out.push(row.id);
      }
      r.dispatchMouseEventFromHitMap(input("move"), normal);
      expect(over).toEqual(["row0"]);
      r.setFramePlan(() => ({
        deferHover,
        projection: { renderable: content, translateX: 0, translateY: -1 },
      }));
      await renderOnce();
      await r.idle();
      if (deferHover) {
        expect(over).toEqual(["row0"]);
        expect(out).toEqual([]);
        // The old host generation remains authoritative after newer paint.
        r.dispatchMouseEventFromHitMap(input("move"), normal);
        expect(over).toEqual(["row0"]);
      } else {
        expect(over).toEqual(["row0", "row1"]);
        expect(out).toEqual(["row0"]);
      }
    } finally {
      r.destroy();
    }
  }
});

for (const route of ["ordinary", "snapshot"])
  test(`captured paint retains clipped hits and drop targets through ${route} input`, async () => {
    const { r, renderOnce, mockMouse } = await setup();
    try {
      const backdrop = new BoxRenderable(r, { width: 12, height: 4 });
      const under = new BoxRenderable(r, {
        position: "absolute",
        width: 4,
        height: 2,
        overflow: "hidden",
      });
      const source = new BoxRenderable(r, { width: 8, height: 2, flexShrink: 0 });
      const cover = new BoxRenderable(r, {
        position: "absolute",
        left: 2,
        top: 0,
        width: 1,
        height: 1,
        zIndex: 10,
      });
      r.root.add(backdrop);
      r.root.add(under);
      under.add(source);
      r.root.add(cover);
      const events: string[] = [];
      source.onMouse = (event) => events.push(`source:${event.type}`);
      under.onMouse = (event) => events.push(`under:${event.type}`);
      let painted: RenderHitMap | undefined;
      r.setFramePlan(() => ({
        onHitMap: (map) => {
          painted = map;
        },
      }));
      const send = async (type: "down" | "drag" | "up", map: RenderHitMap) => {
        if (route === "ordinary") await mockMouse.emitMouseEvent(type, 1, 0, 0, { delayMs: 0 });
        else r.dispatchMouseEventFromHitMap(input(type, 1, 0), map);
      };
      await renderOnce();
      if (!painted) throw new Error("Missing initial hit map");
      await send("down", painted);
      await send("drag", painted);
      await renderOnce();
      const during = painted;
      expect(during.hitTest(1, 0)).toBe(source.num);
      expect(during.hitTest(2, 0)).toBe(cover.num);
      expect(during.hitTest(5, 0)).toBe(backdrop.num);
      expect(r.hitTest(1, 0)).toBe(source.num);
      events.length = 0;
      await send("drag", during);
      expect(events).toContain("under:over");
      expect(events).toContain("source:drag");
      await send("up", during);
      expect(events).toContain("source:drag-end");
      expect(events).toContain("under:drop");
      expect(events).not.toContain("source:drop");
      const frame = r.frameId;
      await send("down", during);
      expect(r.frameId).toBe(frame);
      expect(events).toContain("source:down");
      expect(during.hitTest(1, 0)).toBe(source.num);
    } finally {
      r.destroy();
    }
  });
