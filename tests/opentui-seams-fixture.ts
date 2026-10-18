// Bundled by opentui-seams.test.ts against the patched TypeScript and WASM sources.
import { expect, spyOn, test } from "bun:test";
import { Writable } from "node:stream";
import { Terminal } from "@xterm/xterm";
import { createTestStdout } from "../node_modules/@opentui/core/testing/test-streams";
import {
  CliRenderEvents,
  BoxRenderable,
  TextRenderable,
  type CliRendererErrorEvent,
  MouseEvent,
  NativeSession,
  ScrollBoxRenderable,
  SyntaxStyle,
  RGBA,
  type RawMouseEvent,
} from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { detectOpenTuiSeams, type RenderHitMap } from "../packages/core/src/web/opentui-seams";
import { detectScrollableViewport } from "../packages/core/src/web/opentui-seams";
import { PixelController } from "../packages/core/src/web/pixel-scroll/controller";
import { decode, decodePayload, encode, OSC } from "../packages/core/src/pixel-scroll/protocol";
import { MarkdownEditorRenderable } from "../packages/markdown-editor/src/view/EditorRenderable";

const bytes = (s: string) => new TextEncoder().encode(s);
const start = "\x1b[?2026h",
  end = "\x1b[?2026l";
const modifiers = { shift: false, alt: false, ctrl: false, meta: true };

test("planned output keeps one envelope across partial sink writes and backpressure", async () => {
  const chunks: Buffer[] = [];
  let pressure = 0;
  let drains = 0;
  const sink: Writable = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      setImmediate(() => {
        if (sink.writableNeedDrain) pressure++;
        done();
      });
    },
  });
  sink.on("drain", () => drains++);
  const session = new NativeSession(sink, {
    output: { chunkSize: 256, spanCapacity: 32, maxBytes: 8192n, controlCapacity: 128 },
    outputBufferSize: 17,
  });
  function hasFrameOutput(value: NativeSession): value is NativeSession & {
    beginFrameOutput(): void;
    endFrameOutput(commit: boolean): Promise<void>;
  } {
    return ["beginFrameOutput", "endFrameOutput"].every(
      (key) => typeof Reflect.get(value, key) === "function",
    );
  }
  if (!hasFrameOutput(session)) throw new Error("Missing planned output");
  try {
    const limit = Number(session.maxAtomicWriteBytes);
    expect(limit).toBeGreaterThan(0);
    const parts = [start, "A".repeat(limit), "B".repeat(limit), end];
    session.beginFrameOutput();
    for (const part of parts) {
      expect(session.write(bytes(part))).toBe(true);
      await session.idle();
    }
    expect(chunks).toEqual([]);
    const accept = session.write.bind(session);
    let attempts = 0;
    // Drive native admission pressure after the opening batch was accepted.
    // Unlike Writable.write(false), this rejects a batch without consuming it.
    const admission = spyOn(session, "write").mockImplementation((batch) =>
      ++attempts === 2 ? false : accept(batch),
    );
    try {
      await session.endFrameOutput(true);
    } finally {
      admission.mockRestore();
    }
    expect(attempts).toBeGreaterThan(3);
    const wire = Buffer.concat(chunks).toString();
    expect(wire).toBe(parts.join(""));
    expect(wire.split(start)).toHaveLength(2);
    expect(wire.split(end)).toHaveLength(2);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((chunk) => chunk.length <= 17)).toBe(true);
    expect(pressure).toBe(chunks.length);
    expect(drains).toBe(pressure);
  } finally {
    await session.close();
    sink.destroy();
  }
});

async function setup(width = 12, height = 4, outputBufferSize?: number) {
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
    ...(outputBufferSize === undefined
      ? {}
      : { nativeSession: new NativeSession(stdout, { outputBufferSize }) }),
  });
  const found = detectOpenTuiSeams(setup.renderer);
  if (!found.available) throw new Error(`Missing seams: ${found.missing.join(", ")}`);
  return { ...setup, r: found.renderer, chunks, stdout };
}

test("partial native frame reads keep checkpoint metadata after the complete paint", async () => {
  const f = await setup(12, 4, 17);
  const terminal = new Terminal({ cols: 12, rows: 4, allowProposedApi: true });
  await new Promise<void>((resolve) => terminal.write(f.chunks.join(""), resolve));
  f.stdout._write = (chunk: Buffer, _encoding, done) => terminal.write(chunk, done);
  const observed: { op: string; rows: string[] }[] = [];
  terminal.parser.registerOscHandler(OSC, (payload) => {
    const operation = decodePayload(payload);
    if (operation?.op === "register" || operation?.op === "commit")
      observed.push({
        op: operation.op,
        rows: [0, 1].map(
          (y) => terminal.buffer.active.getLine(y)?.translateToString(true).trimEnd() ?? "",
        ),
      });
    return true;
  });
  const view = new BoxRenderable(f.r, { width: 12, height: 2, overflow: "hidden" });
  const content = new BoxRenderable(f.r, { width: 12, height: 4, flexShrink: 0 });
  view.add(content);
  f.r.root.add(view);
  for (const text of ["AAAA", "BBBB", "CCCC", "DDDD"])
    content.add(new TextRenderable(f.r, { content: text, height: 1, width: 12 }));
  f.r.setFramePlan(() => ({
    before: bytes(encode({ op: "begin", version: 1, generation: 1 })),
    after: bytes(
      encode({
        op: "register",
        version: 1,
        generation: 1,
        id: 1,
        origin: 0,
        rect: { x: 0, y: 0, width: 12, height: 2 },
      }),
    ),
    projection: {
      renderable: content,
      translateX: 0,
      translateY: -1,
      after: bytes(
        encode({ op: "step", version: 1, id: 1, generation: 1, fraction: 0.5 }) +
          encode({ op: "commit", version: 1, generation: 1 }),
      ),
    },
  }));
  try {
    await f.renderOnce();
    await f.r.idle();
    expect(observed).toEqual([
      { op: "register", rows: ["AAAA", "BBBB"] },
      { op: "commit", rows: ["BBBB", "CCCC"] },
    ]);
  } finally {
    await f.dispose();
    terminal.dispose();
  }
});

test("logical editor focus precedes cursor delivery through a held borrowed sink", async () => {
  const f = await setup(12, 16);
  const terminal = new Terminal({ cols: 12, rows: 16, allowProposedApi: true });
  const style = SyntaxStyle.fromStyles(
    { default: { fg: RGBA.fromHex("#eeeeee") } },
    f.r.nativeScene,
  );
  const editor = new MarkdownEditorRenderable(f.r, {
    position: "absolute",
    top: 1,
    width: 12,
    height: 4,
    value: "alpha\n\nbeta",
    syntaxStyle: style,
  });
  f.r.root.add(editor);
  f.r.setFramePlan(() => ({}));
  const writeTerminal = (wire: string) =>
    new Promise<void>((resolve) => terminal.write(wire, resolve));
  let held: { chunk: Buffer; done: () => void } | undefined;
  const ordering: { stage: string; focused: boolean; cursorY: number }[] = [];
  try {
    await f.renderOnce();
    await writeTerminal(f.chunks.join(""));
    await writeTerminal("\x1b[13;1H");
    const pending = Promise.withResolvers<void>();
    f.stdout._write = (chunk: Buffer, _encoding, done) => {
      held = { chunk: Buffer.from(chunk), done };
      pending.resolve();
    };
    editor.focus();
    const rendering = f.renderOnce();
    await pending.promise;
    expect(editor.focused).toBe(true);
    expect(terminal.buffer.active.cursorY).toBe(12);
    ordering.push({
      stage: "held",
      focused: editor.focused,
      cursorY: terminal.buffer.active.cursorY,
    });
    f.stdout._write = (chunk: Buffer, _encoding, done) => terminal.write(chunk, done);
    if (!held) throw new Error("Missing borrowed output");
    terminal.write(held.chunk, held.done);
    held = undefined;
    await rendering;
    await f.r.idle();
    expect(editor.focused).toBe(true);
    expect(terminal.buffer.active.cursorY).toBe(1);
    ordering.push({
      stage: "delivered",
      focused: editor.focused,
      cursorY: terminal.buffer.active.cursorY,
    });
    const proof = process.env["LUCIOLE_CURSOR_FOCUS_PROOF"];
    if (proof) await Bun.write(proof, JSON.stringify(ordering, null, 2));
  } finally {
    if (held) terminal.write(held.chunk, held.done);
    f.stdout._write = (chunk: Buffer, _encoding, done) => terminal.write(chunk, done);
    await f.dispose();
    terminal.dispose();
  }
});

test("editor viewport bounds stay canonical while the next projection yields", async () => {
  const f = await setup(12, 8);
  const style = SyntaxStyle.fromStyles(
    { default: { fg: RGBA.fromHex("#eeeeee") } },
    f.r.nativeScene,
  );
  const editor = new MarkdownEditorRenderable(f.r, {
    position: "absolute",
    top: 1,
    width: 12,
    height: 4,
    value: "alpha\n\nbeta",
    syntaxStyle: style,
  });
  f.r.root.add(editor);
  try {
    await f.renderOnce();
    const canonical = editor.scrollableViewport.rect;
    expect(canonical.y).toBe(1);
    f.r.setFramePlan(() => ({ projection: { renderable: editor, translateX: 0, translateY: -1 } }));
    const paint = f.r.nativeScene.paint.bind(f.r.nativeScene);
    let observed: typeof canonical | undefined;
    const painting = spyOn(f.r.nativeScene, "paint").mockImplementation((...args) => {
      const result = paint(...args);
      if (Reflect.get(f.r, "isProjectionPass") !== true) return result;
      return Promise.resolve(result).then(
        () =>
          new Promise<void>((resolve) => {
            setImmediate(() => {
              observed = editor.scrollableViewport.rect;
              resolve();
            });
          }),
      );
    });
    try {
      await f.renderOnce();
    } finally {
      painting.mockRestore();
    }
    expect(observed).toEqual(canonical);
    expect(editor.scrollableViewport.rect).toEqual(canonical);
  } finally {
    await f.dispose();
  }
});

test("private input waits through a yielding canonical paint, before planning its projection", async () => {
  const f = await setup();
  const view = new ScrollBoxRenderable(f.r, { width: 12, height: 2 });
  for (let i = 0; i < 8; i++)
    view.add(new TextRenderable(f.r, { content: `row ${i}`, height: 1, flexShrink: 0 }));
  f.r.root.add(view);
  const viewport = detectScrollableViewport(view);
  if (!viewport) throw new Error("Missing viewport");
  await f.renderOnce();
  viewport.set(0.75);
  let receive: ((sequence: string) => void) | undefined;
  const subscription = spyOn(f.r, "subscribeOsc").mockImplementation((handler) => {
    receive = handler;
    return () => {};
  });
  const wires: string[] = [];
  const controller = PixelController.attach(f.r, (wire) => wires.push(wire));
  const queries = (wires[0] ?? "").slice(start.length, -end.length);
  const query = decode(queries.slice(0, queries.indexOf("\x1b\\") + 2));
  if (!controller || !receive || query?.op !== "query") throw new Error("Missing discovery");
  receive(
    encode({
      op: "capability",
      version: 1,
      nonce: query.nonce,
      reason: "ready",
      snapshot: true,
      precise: true,
    }),
  );
  let afterInput = -1;
  let paintFlag = false;
  const errors: CliRendererErrorEvent[] = [];
  f.r.on(CliRenderEvents.RENDER_ERROR, (error: CliRendererErrorEvent) => errors.push(error));
  try {
    await f.renderOnce();
    const paint = f.r.nativeScene.paint.bind(f.r.nativeScene);
    let yielded = false;
    const painting = spyOn(f.r.nativeScene, "paint").mockImplementation((...args) => {
      const result = paint(...args);
      if (yielded) return result;
      yielded = true;
      return Promise.resolve(result).then(
        () =>
          new Promise<void>((resolve) => {
            setImmediate(() => {
              paintFlag = Reflect.get(f.r, "isFramePlanPass") === true;
              receive?.(
                encode({
                  op: "wheel",
                  version: 1,
                  id: 1,
                  generation: 1,
                  phase: 0.75,
                  x: 2,
                  y: 1,
                  modifiers: 0,
                  dx: 0,
                  dy: 0.5,
                  source: "precise",
                }),
              );
              afterInput = viewport.position;
              resolve();
            });
          }),
      );
    });
    try {
      await f.renderOnce();
    } finally {
      painting.mockRestore();
    }
    expect(paintFlag).toBe(true);
    expect(afterInput).toBe(0.75);
    expect(viewport.position).toBe(1.25);
    expect(Reflect.get(f.r, "isFramePlanPass")).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    controller.dispose();
    subscription.mockRestore();
    await f.dispose();
  }
});

test("no plan and an empty plan share cells, one envelope and no-op suppression", async () => {
  const wires: string[] = [];
  for (const planned of [false, true]) {
    const { r, renderOnce, chunks, dispose } = await setup(8, 2);
    try {
      r.root.add(new TextRenderable(r, { content: "BASE", width: 8, height: 1 }));
      if (planned) r.setFramePlan(() => ({}));
      await renderOnce();
      await r.idle();
      const wire = chunks.join("");
      expect(wire).toContain("BASE");
      expect(wire.split(start)).toHaveLength(2);
      expect(wire.split(end)).toHaveLength(2);
      wires.push(wire);
      chunks.length = 0;
      await renderOnce();
      await r.idle();
      expect(chunks).toEqual([]);
    } finally {
      await dispose();
    }
  }
  expect(wires[0]).toBe(wires[1]);
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
  r.nativeScene.lifecyclePasses.add(content);
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
        expect(Reflect.get(r, "isFramePlanPass")).toBe(true);
        normal = map;
      },
      projection: {
        renderable: content,
        translateX: 0,
        translateY: -1,
        before: bytes("<project>"),
        after: bytes("<commit>"),
        onHitMap: (map) => {
          expect(Reflect.get(r, "isFramePlanPass")).toBe(true);
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

test("ordered normal and projected segments use one envelope and distinct paint identities without logical translation changes", async () => {
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
    expect(Reflect.get(r, "isFramePlanPass")).toBe(false);
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
      updates: logicalPasses * 2,
      lifecycle: logicalPasses * 2,
      before: logicalPasses * 2,
      after: logicalPasses * 2,
    });
    const frameId = r.frameId;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await r.idle();
    expect(r.frameId).toBe(frameId);
  } finally {
    r.destroy();
    await r.closed;
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
    await r.closed;
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
    await r.closed;
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
    await r.closed;
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
    await r.closed;
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
    await r.closed;
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
    await r.closed;
  }
});

test("thumb paint follows fractional rows while its logical value stays canonical", async () => {
  const { r, child, inner, renderOnce, captureCharFrame } = await scrollScene();
  try {
    const slider = child.verticalScrollBar.slider;
    inner.set(0);
    await renderOnce();
    const before = captureCharFrame();
    inner.set(0.875);
    await renderOnce();
    expect(child.scrollTop).toBe(0);
    expect(slider.value).toBe(0);
    expect(captureCharFrame()).not.toBe(before);
  } finally {
    r.destroy();
    await r.closed;
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
    await r.closed;
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
    await r.closed;
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
        expect(over).toEqual(["row0"]);
        expect(out).toEqual([]);
      }
    } finally {
      r.destroy();
      await r.closed;
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
      await r.closed;
    }
  });

test("a drag begun on the projected row keeps its source through paint and release", async () => {
  const { r, rows, content, renderOnce, projected } = await scene();
  try {
    const events: { id: string; type: string; source?: string }[] = [];
    for (const node of [content, ...rows])
      node.onMouse = (event) =>
        events.push({ id: node.id, type: event.type, source: event.source?.id });
    r.dispatchMouseEventFromHitMap(input("down"), projected);
    r.dispatchMouseEventFromHitMap(input("drag"), projected);
    let afterPaint: RenderHitMap | undefined;
    r.setFramePlan(() => ({
      deferHover: true,
      projection: {
        renderable: content,
        translateX: 0,
        translateY: -1,
        onHitMap(map) {
          afterPaint = map;
        },
      },
    }));
    await renderOnce();
    if (!afterPaint) throw new Error("Missing captured projection");
    expect(afterPaint.hitTest(0, 0)).toBe(rows[1]?.num);
    events.length = 0;
    r.dispatchMouseEventFromHitMap(input("drag"), afterPaint);
    expect(events).toContainEqual({ id: "row1", type: "drag", source: undefined });
    expect(events).toContainEqual({ id: "content", type: "over", source: "row1" });
    r.dispatchMouseEventFromHitMap(input("up"), afterPaint);
    expect(events).toContainEqual({ id: "row1", type: "drag-end", source: undefined });
    expect(events).toContainEqual({ id: "content", type: "drop", source: "row1" });
    const frame = r.frameId;
    events.length = 0;
    r.dispatchMouseEventFromHitMap(input("down"), afterPaint);
    expect(r.frameId).toBe(frame);
    expect(events).toContainEqual({ id: "row1", type: "down", source: undefined });
  } finally {
    r.destroy();
    await r.closed;
  }
});
