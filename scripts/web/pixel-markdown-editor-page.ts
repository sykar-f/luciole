/* eslint-disable no-magic-numbers -- Fixed browser fixture geometry and color bands. */
import "../../packages/core/src/web/setup";
import type {} from "../../packages/core/src/web/opentui/ffi";
import { PassThrough } from "node:stream";
import {
  createCliRenderer,
  ScrollBoxRenderable,
  TextRenderable,
  SyntaxStyle,
  RGBA,
} from "@opentui/core";
import { Terminal } from "@xterm/xterm";
import { WebglAddon } from "../../packages/core/src/web/xterm-webgl/addon/WebglAddon";
import { PixelScrollAddon } from "../../packages/core/src/web/pixel-scroll/host";
import { PixelController } from "../../packages/core/src/web/pixel-scroll/controller";
import { detectScrollableViewport } from "../../packages/core/src/web/opentui-seams";
import { isInputStream, terminalOutput } from "../../packages/core/src/web/streams";
import type { Presentation } from "../../packages/core/src/web/pixel-scroll/presentation";
import { decode } from "../../packages/core/src/pixel-scroll/protocol";

import { MarkdownEditorRenderable } from "../../packages/markdown-editor/src/view/EditorRenderable";

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
const left = new ScrollBoxRenderable(r, { width: 20, height: 14, focusable: true });
for (let i = 0; i < 80; i++)
  left.add(new TextRenderable(r, { content: `Other ${i}`, height: 1, flexShrink: 0 }));
r.root.add(left);
left.focus();
let copied = "";
const editor = new MarkdownEditorRenderable(r, {
  position: "absolute",
  left: 23,
  top: 1,
  width: 26,
  height: 12,
  value: Array.from({ length: 40 }, (_, i) => `ROW ${String(i).padStart(3, "0")} selectable`).join(
    "\n\n",
  ),
  syntaxStyle: SyntaxStyle.fromStyles({ default: { fg: RGBA.fromHex("#e6edf3") } }),
  onCopy: (text) => {
    copied = text;
    void navigator.clipboard.writeText(text);
  },
});
r.root.add(editor);
const events: { type: string; y: number; position: number }[] = [];
editor.onMouse = (event) => {
  events.push({ type: event.type, y: event.y, position: editor.scrollableViewport.position });
};
let presented: Presentation | undefined;
webgl.pixels.onPresent((p) => {
  presented = p;
});
const canvas = document.querySelector(".xterm-webgl-layer");
if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Missing canvas");
const gl = canvas.getContext("webgl2");
if (!gl) throw new Error("Missing context");
const frames: {
  origin: number;
  phase: number;
  generation: number;
  content: number[];
  thumb: number[];
}[] = [];
const capture = () => {
  const data = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
  const v = editor.scrollableViewport.rect;
  const W = canvas.width / terminal.cols,
    H = canvas.height / terminal.rows;
  const content: number[] = [],
    thumb: number[] = [];
  for (let y = Math.round(v.y * H); y < Math.round((v.y + v.height) * H); y++) {
    for (let x = Math.round(v.x * W); x < Math.round((v.x + v.width + 1) * W); x++) {
      const at = ((canvas.height - 1 - y) * canvas.width + x) * 4;
      (x < Math.round((v.x + v.width) * W) ? content : thumb).push(...data.slice(at, at + 3));
    }
  }
  return { content, thumb };
};
terminal.onRender(() => {
  if (presented?.rect.x !== editor.screenX) return;
  frames.push({
    origin: presented.origin,
    phase: presented.phase,
    generation: presented.generation,
    ...capture(),
  });
});
const point = (x: number, y: number) => {
  const box = document.querySelector(".xterm-screen")?.getBoundingClientRect();
  if (!box) throw new Error("Missing screen");
  return {
    clientX: box.left + (x * box.width) / terminal.cols,
    clientY: box.top + (y * box.height) / terminal.rows,
  };
};
Object.assign(window, {
  probe: {
    terminal,
    r,
    editor,
    events,
    debug: () => {
      const history: unknown = Reflect.get(controller ?? {}, "history");
      const session: unknown = Reflect.get(host, "session");
      const held: unknown = Reflect.get(host, "held");
      return {
        reports: reports.slice(-8),
        history,
        session,
        held,
        hostDragging: Reflect.get(host, "dragging") === true,
      };
    },
    frames,
    capture,
    state: () => ({
      presented,
      otherPosition: detectScrollableViewport(left)?.position,
      position: editor.scrollableViewport.position,
      origin: editor.scrollableViewport.origin,
      rect: editor.scrollableViewport.rect,
      selection: editor.controller.state.selection,
      copied,
      cellHeight: canvas.height / terminal.rows,
      cellWidth: canvas.width / terminal.cols,
      cursor: terminal.buffer.active.cursorY,
      bar: Array.from({ length: editor.height }, (_, y) =>
        terminal.buffer.active
          .getLine(editor.screenY + y)
          ?.getCell(editor.screenX + editor.width - 1)
          ?.getChars(),
      ).join(""),
    }),
    wheel: (x: number, y: number, rows: number) => {
      document.querySelector(".xterm-screen")?.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          ...point(x, y),
          deltaY:
            (rows *
              (document.querySelector(".xterm-screen")?.getBoundingClientRect().height ?? 0)) /
            terminal.rows,
        }),
      );
    },
    pointer: (type: string, x: number, y: number, buttons = 0) => {
      document.querySelector(".xterm-screen")?.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons,
          detail: type === "mousedown" || type === "mouseup" ? 1 : 0,
          ...point(x, y),
        }),
      );
    },
  },
});
terminal.focus();
