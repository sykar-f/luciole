// Bundled by opentui-seams.test.ts against the patched TypeScript and WASM sources.
import { expect, test } from "bun:test";
import { Writable } from "node:stream";
import { BoxRenderable, TextRenderable, type MouseEvent, type RawMouseEvent } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { detectOpenTuiSeams, type RenderHitMap } from "../packages/core/src/web/opentui-seams";
import baseline from "./fixtures/opentui-seams/plain-frame.json";

const bytes = (s: string) => new TextEncoder().encode(s);
const start = "\x1b[?2026h",
  end = "\x1b[?2026l";
const modifiers = { shift: false, alt: false, ctrl: false, meta: true };
async function setup(width = 12, height = 4) {
  const chunks: string[] = [];
  const stdout = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk.toString());
      done();
    },
  }) as NodeJS.WriteStream;
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
      expect(positions.every((pos, i) => pos >= 0 && (i === 0 || pos > positions[i - 1]!))).toBe(
        true,
      );
    }
    expect(normal.frameId).toBe(projected.frameId);
    expect(normal.passId).not.toBe(projected.passId);
    expect(normal.hitTest(0.2, 0.8)).toBe(rows[0]!.num);
    expect(projected.hitTest(0.2, 0.8)).toBe(rows[1]!.num);
    expect(projected.hitTest(0, 1)).toBe(rows[2]!.num); // entering edge, previously culled
    expect(projected.hitTest(0, 2)).not.toBe(rows[3]!.num); // viewport clips
    expect(projected.hitTest(-0.1, 0)).toBe(0);
    expect(projected.hitTest(Infinity, 0)).toBe(0);
    expect(projected.origin(rows[1]!.num)).toEqual({ x: 0, y: 0 });
    expect(rows[1]!.y).toBe(1);
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
    rows[0]!.destroy();
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
