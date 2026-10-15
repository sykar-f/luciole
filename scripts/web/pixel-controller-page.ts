/* eslint-disable no-magic-numbers -- Fixed browser fixture geometry and color bands. */
import "../../packages/core/src/web/setup";
import type {} from "../../packages/core/src/web/opentui/ffi";
import { PassThrough } from "node:stream";
import {
  createCliRenderer,
  ScrollBoxRenderable,
  TextRenderable,
  BoxRenderable,
} from "@opentui/core";
import { Terminal } from "@xterm/xterm";
import { WebglAddon } from "../../packages/core/src/web/xterm-webgl/addon/WebglAddon";
import { PixelScrollAddon } from "../../packages/core/src/web/pixel-scroll/host";
import { PixelController } from "../../packages/core/src/web/pixel-scroll/controller";
import { detectScrollableViewport } from "../../packages/core/src/web/opentui-seams";
import { isInputStream, terminalOutput } from "../../packages/core/src/web/streams";
import type { Presentation } from "../../packages/core/src/web/pixel-scroll/presentation";
import { decode } from "../../packages/core/src/pixel-scroll/protocol";

const parameters = new URLSearchParams(location.search);
const terminal = new Terminal({
  cols: 50,
  rows: 16,
  fontSize: 14,
  allowProposedApi: true,
  cursorBlink: false,
  macOptionClickForcesSelection: true,
});
terminal.open(document.body);
const webgl = new WebglAddon(true);
terminal.loadAddon(webgl);
if (!webgl.pixels) throw new Error("The controller fixture requires WebGL2");
const host = new PixelScrollAddon(webgl.pixels);
if (!parameters.has("noHost")) terminal.loadAddon(host);
let remainder = 0;
terminal.attachCustomWheelEventHandler((event) => {
  if (!parameters.has("noHost") && !host.wheel(event)) return false;
  const box = document.querySelector(".xterm-screen")?.getBoundingClientRect();
  if (!box) return false;
  remainder += event.deltaY / (box.height / terminal.rows);
  const rows = Math.trunc(remainder);
  remainder -= rows;
  const x = Math.floor(((event.clientX - box.left) * terminal.cols) / box.width);
  const y = Math.floor(((event.clientY - box.top) * terminal.rows) / box.height);
  terminal.input(`\x1b[<${rows < 0 ? 64 : 65};${x + 1};${y + 1}M`.repeat(Math.abs(rows)));
  return false;
});
const stdin = new PassThrough();
if (!isInputStream(stdin)) throw new Error("Expected readable stdin");
let controller: PixelController | undefined;
const reports: unknown[] = [];
let maxInputMs = 0;
terminal.onData((data) => {
  const message = decode(data);
  if (message) reports.push(message);
  controller?.ordinary(data);
  const began = performance.now();
  stdin.write(data);
  if (message?.op === "wheel") maxInputMs = Math.max(maxInputMs, performance.now() - began);
});
const { requestAnimationFrame, cancelAnimationFrame } = globalThis;
let wire = "";
const r = await createCliRenderer({
  stdin,
  stdout: terminalOutput({ columns: 50, rows: 16 }, (bytes, done) => {
    wire += new TextDecoder().decode(bytes);
    terminal.write(bytes, done);
  }),
  width: 50,
  height: 16,
  useThread: false,
  exitOnCtrlC: false,
  exitSignals: [],
});
Object.assign(globalThis, { requestAnimationFrame, cancelAnimationFrame });
controller = PixelController.attach(r, (commands) => terminal.write(commands), {
  pixelScroll: !parameters.has("optOut"),
});
const left = new ScrollBoxRenderable(r, {
  id: "long",
  width: 24,
  height: 14,
  focusable: true,
  border: true,
});
const right = new ScrollBoxRenderable(r, {
  id: "other",
  position: "absolute",
  left: 26,
  top: 0,
  width: 24,
  height: 14,
  border: true,
});
r.root.add(left);
r.root.add(right);
left.focus();
const color = (row: number) =>
  `#${[40 + (row % 160), 60 + ((row * 17) % 160), 80 + ((row * 31) % 160)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
const events: { id: string; type: string; source?: string }[] = [];
for (let i = 0; i < 240; i++) {
  const row = new TextRenderable(r, {
    id: `row-${i}`,
    content: `ROW ${String(i).padStart(3, "0")} selectable`,
    width: "100%",
    height: 1,
    flexShrink: 0,
    selectable: true,
    bg: color(i),
  });
  row.onMouse = (event) =>
    events.push({
      id: row.id,
      type: event.type,
      ...(event.source ? { source: event.source.id } : {}),
    });
  left.add(row);
  right.add(new TextRenderable(r, { content: `OTHER ${i}`, height: 1, flexShrink: 0 }));
}
const nested = new ScrollBoxRenderable(r, {
  id: "nested",
  width: 17,
  height: 4,
  position: "absolute",
  top: 5,
  left: 1,
});
for (let i = 0; i < 20; i++)
  nested.add(new TextRenderable(r, { content: `NESTED ${i}`, height: 1, flexShrink: 0 }));
let nestedShown = false;
let popup: BoxRenderable | undefined;
let copied = "";
r.keyInput.on("keypress", (key) => {
  if (key.ctrl && key.name === "c") {
    copied = r.getSelection()?.getSelectedText() ?? "";
    key.preventDefault();
  }
});
let presented: Presentation | undefined;
webgl.pixels.onPresent((p) => {
  presented = p;
});
const canvas = document.querySelector(".xterm-webgl-layer");
if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Missing canvas");
canvas.addEventListener("webglcontextlost", () => {
  presented = undefined;
});
const gl = canvas.getContext("webgl2");
if (!gl) throw new Error("Missing context");
const frames: {
  origin: number;
  phase: number;
  generation: number;
  rect: unknown;
  column: number[];
  thumb: number[];
}[] = [];
terminal.onRender(() => {
  if (!presented) return;
  const data = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
  const cellWidth = canvas.width / terminal.cols;
  const column: number[] = [],
    thumb: number[] = [];
  // The space after ROW carries a solid text background without glyph pixels.
  const x = Math.floor((presented.rect.x + 3.5) * cellWidth);
  const barX = Math.floor((left.verticalScrollBar.x + 0.5) * cellWidth);
  for (let y = 0; y < canvas.height; y++) {
    for (const [target, columnX] of [
      [column, x],
      [thumb, barX],
    ] as const) {
      const at = ((canvas.height - 1 - y) * canvas.width + columnX) * 4;
      target.push(...data.slice(at, at + 3));
    }
  }
  frames.push({
    origin: presented.origin,
    phase: presented.phase,
    generation: presented.generation,
    rect: presented.rect,
    column,
    thumb,
  });
});
const view = (box: ScrollBoxRenderable) => {
  const v = detectScrollableViewport(box);
  if (!v) throw new Error("Missing viewport");
  return { position: v.position, origin: v.origin, max: v.max, rect: v.rect };
};
Object.assign(window, {
  probe: {
    terminal,
    r,
    reports,
    // eslint-disable-next-line no-control-regex -- Inspect complete OSC frames in captured terminal bytes.
    operations: () => (wire.match(/\x1b\]19462;[^\x1b]*\x1b\\/g) ?? []).map(decode).slice(-20),
    events,
    frames,
    color,
    state: () => ({
      left: view(left),
      right: view(right),
      nested: view(nested),
      presented,
      copied,
      maxInputMs,
      selection: r.getSelection()?.getSelectedText() ?? "",
      nativeSelection: terminal.getSelection(),
      cellHeight: webgl.pixels?.cellHeight,
      cellWidth: canvas.width / terminal.cols,
      width: canvas.width,
      height: canvas.height,
      bar: {
        x: left.verticalScrollBar.x,
        y: left.verticalScrollBar.y,
        width: left.verticalScrollBar.width,
        height: left.verticalScrollBar.height,
      },
    }),
    point: (x: number, y: number) => {
      const box = document.querySelector(".xterm-screen")?.getBoundingClientRect();
      if (!box) throw new Error("Missing screen");
      return {
        clientX: box.left + (x * box.width) / terminal.cols,
        clientY: box.top + (y * box.height) / terminal.rows,
      };
    },
    wheel: (x: number, y: number, rows: number) => {
      const box = document.querySelector(".xterm-screen")?.getBoundingClientRect();
      const target = document.querySelector(".xterm-screen");
      if (!box || !target) throw new Error("Missing screen");
      target.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          clientX: box.left + (x * box.width) / terminal.cols,
          clientY: box.top + (y * box.height) / terminal.rows,
          deltaY: (rows * box.height) / terminal.rows,
        }),
      );
    },
    pointer: (
      type: string,
      x: number,
      y: number,
      buttons = 0,
      shiftKey = false,
      altKey = false,
    ) => {
      const box = document.querySelector(".xterm-screen")?.getBoundingClientRect();
      const target = document.querySelector(".xterm-screen");
      if (!box || !target) throw new Error("Missing screen");
      target.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          detail: type === "mousedown" || type === "mouseup" ? 1 : 0,
          buttons,
          shiftKey,
          altKey,
          clientX: box.left + (x * box.width) / terminal.cols,
          clientY: box.top + (y * box.height) / terminal.rows,
        }),
      );
    },
    selectable: (value: boolean) => {
      r.clearSelection();
      for (const row of left.getChildren()) row.selectable = value;
    },
    nested: () => {
      if (!nestedShown) {
        left.add(nested);
        nestedShown = true;
      }
    },
    popup: () => {
      popup = new BoxRenderable(r, {
        position: "absolute",
        left: (presented?.rect.x ?? 1) + 1,
        top: (presented?.rect.y ?? 1) + 1,
        width: 10,
        height: 3,
        zIndex: 100,
        backgroundColor: "red",
      });
      r.root.add(popup);
    },
    closePopup: () => {
      popup?.destroy();
    },
    resetNested: () => {
      const inner = detectScrollableViewport(nested),
        outer = detectScrollableViewport(left);
      inner?.set(0);
      if (outer) outer.set(Math.floor(outer.position));
    },
    loseContext: () => gl.getExtension("WEBGL_lose_context")?.loseContext(),
    resize: () => {
      terminal.resize(50, 17);
      r.resize(50, 17);
    },
  },
});
terminal.focus();
