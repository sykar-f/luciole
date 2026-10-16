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
import { decode, decodePayload, OSC } from "../../packages/core/src/pixel-scroll/protocol";

import { MarkdownEditorRenderable } from "../../packages/markdown-editor/src/view/EditorRenderable";

const parameters = new URLSearchParams(location.search);
const deferred = new Map<number, FrameRequestCallback>();
let holding = false;
if (parameters.has("burst")) {
  // Wrap before xterm schedules any work. Holding must also catch callbacks that
  // were queued before burst(), when they reach their actual execution point.
  const nativeRequest = globalThis.requestAnimationFrame.bind(globalThis);
  const nativeCancel = globalThis.cancelAnimationFrame.bind(globalThis);
  const scheduled = new Map<number, number>();
  let handle = 1_000_000_000;
  globalThis.requestAnimationFrame = (callback) => {
    const id = ++handle;
    if (holding) deferred.set(id, callback);
    else
      scheduled.set(
        id,
        nativeRequest((time) => {
          scheduled.delete(id);
          if (holding) deferred.set(id, callback);
          else callback(time);
        }),
      );
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => {
    deferred.delete(id);
    const native = scheduled.get(id);
    if (native !== undefined) nativeCancel(native);
    scheduled.delete(id);
  };
}

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
terminal.onData((data) => {
  const message = decode(data);
  if (message) reports.push(message);
  controller?.ordinary(data);
  stdin.write(data);
});
let wire = "";
const { requestAnimationFrame, cancelAnimationFrame } = globalThis;
const r = await createCliRenderer({
  stdin,
  stdout: terminalOutput({ columns: 50, rows: 16 }, (bytes, done) => {
    if (parameters.has("burst")) wire += new TextDecoder().decode(bytes);
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
const marker = parameters.has("burst")
  ? new TextRenderable(r, {
      position: "absolute",
      top: 15,
      left: 0,
      width: 10,
      height: 1,
      content: "initial",
    })
  : undefined;
if (marker) r.root.add(marker);
const events: { type: string; y: number; position: number }[] = [];
editor.onMouse = (event) => {
  events.push({ type: event.type, y: event.y, position: editor.scrollableViewport.position });
};
const readBar = () =>
  Array.from({ length: editor.height }, (_, y) =>
    terminal.buffer.active
      .getLine(editor.screenY + y)
      ?.getCell(editor.screenX + editor.width - 1)
      ?.getChars(),
  ).join("");
const committedBars = new Map<number, string>();
terminal.parser.registerOscHandler(OSC, (payload) => {
  const message = decodePayload(payload);
  if (message?.op === "commit") committedBars.set(message.generation, readBar());
  return false;
});
let presented: Presentation | undefined;
let presentedBar = "";
webgl.pixels.onPresent((p) => {
  presented = p;
  if (p) {
    const bar = committedBars.get(p.generation);
    if (bar === undefined) throw new Error("Missing committed scrollbar signature");
    presentedBar = bar;
    for (const generation of committedBars.keys())
      if (generation <= p.generation) committedBars.delete(generation);
  }
});
const canvas = document.querySelector(".xterm-webgl-layer");
if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Missing canvas");
const gl = canvas.getContext("webgl2");
if (!gl) throw new Error("Missing context");
const frames: {
  origin: number;
  phase: number;
  generation: number;
  bar: string;
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
    bar: presentedBar,
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
    ...(marker
      ? {
          burst: async () => {
            // Hold actual presentation while allowing output/parser tasks to drain.
            holding = true;
            const loop: unknown = Reflect.get(r, "loop");
            if (typeof loop !== "function") throw new Error("Missing diagnostic frame loop");
            for (let i = 0; i < 9; i++) {
              marker.content = `frame ${i}`;
              await Reflect.apply(loop, r, []);
              await new Promise<void>((resolve) => setTimeout(resolve, 0));
            }
          },
          resume: () => {
            holding = false;
            for (const callback of deferred.values()) requestAnimationFrame(callback);
            deferred.clear();
          },
          publication: () =>
            // eslint-disable-next-line no-control-regex -- Inspect complete OSC publication records.
            [...wire.matchAll(/\x1b\]19462;([^\x1b]*)\x1b\\/g)]
              .map((match) => decode(`\x1b]19462;${match[1]}\x1b\\`))
              .filter((message) => message?.op === "begin"),
        }
      : {}),
    r,
    editor,
    events,
    reports,
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
      bar: readBar(),
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
