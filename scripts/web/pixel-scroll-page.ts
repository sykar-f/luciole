/* eslint-disable no-magic-numbers -- Synthetic pixel fixture geometry and colors. */
/** Synthetic xterm-only fixture: no OpenTUI renderer or app-side controller. */
import { Terminal } from "@xterm/xterm";
import { WebglAddon } from "../../packages/core/src/web/xterm-webgl/addon/WebglAddon";
import { PixelScrollAddon } from "../../packages/core/src/web/pixel-scroll/host";
import {
  decode,
  encode,
  MODE,
  type PixelOperation,
} from "../../packages/core/src/pixel-scroll/protocol";
import type { Presentation } from "../../packages/core/src/pixel-scroll/presentation";

const COLS = 12;
const ROWS = 8;
const terminal = new Terminal({
  cols: COLS,
  rows: ROWS,
  allowProposedApi: true,
  fontSize: 14,
  cursorBlink: false,
  theme: { background: "#112233" },
});
terminal.open(document.body);
const webgl = new WebglAddon(true);
terminal.loadAddon(webgl);
const pixels = webgl.pixels;
if (!pixels) throw new Error("Fixture requires WebGL2");
const addon = new PixelScrollAddon(pixels);
terminal.loadAddon(addon);
terminal.attachCustomWheelEventHandler((event) => addon.wheel(event));
const reports: unknown[] = [];
terminal.onData((data) => reports.push(decode(data) ?? data));
let presented: Presentation | undefined;
pixels.onPresent((p) => {
  presented = p;
});
const canvas = document.querySelector(".xterm-webgl-layer");
if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Missing WebGL canvas");
const gl = canvas.getContext("webgl2");
if (!gl) throw new Error("Missing WebGL2 context");
const frames: { generation: number; phase: number; data: number[] }[] = [];
terminal.onRender(() => {
  const bytes = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
  frames.push({
    generation: presented?.generation ?? 0,
    phase: presented?.phase ?? 0,
    data: Array.from(bytes),
  });
});
const sync = (text: string) => `\x1b[?2026h${text}\x1b[?2026l`;
const op = (operation: PixelOperation) => encode(operation);
const rect = { x: 2, y: 2, width: 6, height: 4 };
const color = (row: number) => [
  40 + ((row * 17) % 180),
  50 + ((row * 31) % 180),
  60 + ((row * 43) % 180),
];
const paint = (origin: number, chrome = false) => {
  let stream = "\x1b[?25l";
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const inside =
        x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
      const rgb = inside ? color(origin + y - rect.y + 16) : chrome ? [200, 0, 0] : [17, 34, 51];
      const glyph = inside ? `\x1b[38;2;${color(origin + y - rect.y).join(";")}m▀` : " ";
      stream += `\x1b[${y + 1};${x + 1}H\x1b[48;2;${rgb.join(";")}m${glyph}`;
    }
  }
  return stream;
};
const transaction = (generation: number, origin: number, fraction: number, commit = true) =>
  op({ op: "begin", version: 1, generation }) +
  paint(origin) +
  op({ op: "register", version: 1, generation, id: 1, rect, origin }) +
  (fraction > 0 ? paint(origin + 1) : "") +
  op({ op: "step", version: 1, generation, id: 1, fraction }) +
  (commit ? op({ op: "commit", version: 1, generation }) : "");
const write = async (text: string) => {
  await new Promise<void>((resolve) => terminal.write(text, resolve));
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
};
const point = () => {
  const box = document.querySelector(".xterm-screen")?.getBoundingClientRect();
  if (!box) throw new Error("Missing screen");
  return {
    clientX: box.left + ((rect.x + 1.25) * box.width) / COLS,
    clientY: box.top + ((rect.y + 1.5) * box.height) / ROWS,
  };
};
Object.assign(window, {
  probe: {
    terminal,
    pixels,
    reports,
    frames,
    rect,
    color,
    sync,
    op,
    transaction,
    paint,
    write,
    point,
    mode: `\x1b[?${MODE}h`,
    dimensions: () => ({
      width: canvas.width,
      height: canvas.height,
      cellHeight: pixels.cellHeight,
      cellWidth: canvas.width / COLS,
    }),
    redraw: () => terminal.refresh(0, ROWS - 1),
    glError: () => gl.getError(),
  },
});
