/** The page-side terminal assembly shared by browser and desktop hosts. */
import type { Terminal } from "@xterm/xterm";
import { WebglAddon } from "./xterm-webgl/addon/WebglAddon";
import { PixelScrollAddon } from "./pixel-scroll/host";

export type TerminalViewOptions = {
  /** Row-wheel policy of the host; true lets xterm handle the event. */
  fallbackWheel: (event: WheelEvent) => boolean;
  /** Disable the pixel host for capability diagnostics. Enabled by default. */
  pixelScroll?: boolean;
};

/**
 * The GPU renderer, where the page has WebGL2 (@xterm/addon-webgl): box drawing, blocks
 * and powerline glyphs drawn to the pixel by xterm.js (`customGlyphs`) and every cell a
 * whole device pixel wide, where the DOM renderer draws the font's glyphs in cells of a
 * fractional width: the blocks of a scrollbar then showed a seam between them, and a
 * frame's lines broke where the font's line height left a gap. Without WebGL2, or once
 * the context is lost (a browser keeps about sixteen; the least used go first, a frame's
 * out of view before a visible one's), the DOM renderer draws as before, at once: not a
 * blank screen for the seconds xterm.js would wait for the context to come back. Loaded
 * before the font is sized: the two renderers do not round a cell alike.
 */
export function attachTerminalView(
  terminal: Terminal,
  { fallbackWheel, pixelScroll = true }: TerminalViewOptions,
) {
  let webgl: WebglAddon | undefined;
  const fallBack = () => {
    webgl?.dispose();
    webgl = undefined;
  };
  try {
    webgl = new WebglAddon();
    webgl.onContextLoss(fallBack);
    terminal.loadAddon(webgl);
    terminal.element
      ?.querySelector(".xterm-webgl-layer")
      ?.addEventListener("webglcontextlost", fallBack);
  } catch {
    fallBack();
  }
  const pixels = new PixelScrollAddon(webgl?.pixels);
  if (pixelScroll) terminal.loadAddon(pixels);
  terminal.attachCustomWheelEventHandler(
    (event) => (!pixelScroll || pixels.wheel(event)) && fallbackWheel(event),
  );
  return {
    renderer: (): "webgl" | "dom" => (webgl ? "webgl" : "dom"),
    pixels,
    /** Presentation diagnostics; absent when WebGL2 could not be loaded. */
    presentation: webgl?.pixels,
  };
}

/**
 * The cell under a point of the page, 0-based, as xterm.js reports the mouse: from the
 * screen element's box and the grid. None outside the grid (the padding around it).
 */
export function cellAt(terminal: Terminal, x: number, y: number) {
  const box = terminal.element?.querySelector(".xterm-screen")?.getBoundingClientRect();
  if (!box?.width || !box.height) return undefined;
  const column = Math.floor(((x - box.left) / box.width) * terminal.cols);
  const row = Math.floor(((y - box.top) / box.height) * terminal.rows);
  if (column < 0 || row < 0 || column >= terminal.cols || row >= terminal.rows) return undefined;
  return { column, row };
}

const ESC = "\x1b";
/** SGR mouse buttons of the wheel (OpenTUI enables mode 1006), and their modifier bits. */
const WHEEL_UP = 64;
const WHEEL_DOWN = 65;
const ALT = 8;
const CTRL = 16;

/**
 * The wheel as a terminal reports it to an application that tracks the mouse: one report
 * for each row's height the wheel travels, as native terminals do. xterm.js sends one
 * report per wheel event whatever its distance, and counts a trackpad's pixels for a third
 * (CoreMouseService, consumeWheelEvent): a notch of a hundred pixels moved a document by
 * one report, a trackpad swipe by a fraction of what it travelled. Returns xterm.js's
 * custom wheel handler: false where it reports the turn itself. Shift+wheel and a terminal
 * without mouse tracking are left to xterm.js.
 */
export function wheelReports(terminal: Terminal) {
  /** Pixels travelled the same way and not yet reported: less than a row. */
  let rest = 0;
  return (event: WheelEvent) => {
    if (terminal.modes.mouseTrackingMode === "none" || event.shiftKey || !event.deltaY) return true;
    const cell = cellAt(terminal, event.clientX, event.clientY);
    const box = terminal.element?.querySelector(".xterm-screen")?.getBoundingClientRect();
    if (!cell || !box?.height) return true;
    const row = box.height / terminal.rows;
    const pixels =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? event.deltaY * row
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? event.deltaY * box.height
          : event.deltaY;
    if (Math.sign(pixels) !== Math.sign(rest)) rest = 0;
    rest += pixels;
    const rows = Math.trunc(rest / row);
    rest -= rows * row;
    if (!rows) return false;
    const button =
      (rows < 0 ? WHEEL_UP : WHEEL_DOWN) + (event.altKey ? ALT : 0) + (event.ctrlKey ? CTRL : 0);
    // As typed: the application, the embedding page and its replay all get it (onData).
    terminal.input(`${ESC}[<${button};${cell.column + 1};${cell.row + 1}M`.repeat(Math.abs(rows)));
    return false;
  };
}
