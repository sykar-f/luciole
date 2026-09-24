// One adapter per headless VT emulator, so bench.ts and fidelity.ts run the same code on
// each: feed bytes, read cells, read modes, collect the answers to send back to the PTY.
// A capability an emulator does not expose is `undefined` ("no API"), never a guess:
// fidelity.ts reports it as such.
import { Terminal as XtermTerminal } from "@xterm/headless";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { Ghostty } from "ghostty-web";
import { RenderState, Terminal as VtTerminal } from "libghostty-vt";
import { PersistentTerminal } from "ghostty-opentui";
import { createTestRenderer } from "@opentui/core/testing";
import {
  EmbeddedTerminalRenderable,
  OptimizedBuffer,
  RGBA,
  TextAttributes,
  type CapturedFrame,
} from "@opentui/core";

export type Rgb = readonly [number, number, number];
export type Cell = {
  text: string;
  width: number;
  fg?: Rgb;
  bold: boolean;
  inverse: boolean;
  /** OSC 8 target; `undefined` also when the emulator has no API to read it. */
  link?: string;
};
export type Modes = {
  mouse?: boolean;
  sgrMouse?: boolean;
  bracketedPaste?: boolean;
  decckm?: boolean;
  cursorStyle?: string;
};
export interface Emulator {
  readonly name: string;
  write(bytes: Uint8Array | string): void;
  /** Resolves once everything written is parsed (xterm parses asynchronously). */
  settle(): Promise<void>;
  resize(cols: number, rows: number): void;
  /**
   * Reads every visible cell (codepoint/text, fg, bg, attributes) into a flat array: what
   * a renderer outside the emulator pays for one full frame. Returns cells read.
   */
  extract(): number;
  /** Draws the visible grid into an OpenTUI buffer (the <VtView> alternative path). */
  draw?(buffer: OptimizedBuffer): void;
  /** A readable view of the grid; async because OpenTUI renders to read. */
  grid(): Promise<{ cell(x: number, y: number): Cell | undefined; line(y: number): string }>;
  modes(): Promise<Modes>;
  /** Answers produced for the PTY (DA, DSR…) since the last call; `undefined`: no API. */
  takeResponses(): string | undefined;
  dispose(): void;
}

const CELL_FIELDS = 4;
const decoder = new TextDecoder();
const bytesOf = (data: Uint8Array | string) =>
  typeof data === "string" ? new TextEncoder().encode(data) : data;

// Packed 0xRRGGBB colors, as the emulators hand them over.
const RED_SHIFT = 16;
const GREEN_SHIFT = 8;
const BYTE_MASK = 0xff;
const HEX = 16;
const pack = (r: number, g: number, b: number) => (r << RED_SHIFT) | (g << GREEN_SHIFT) | b;
const rgbOf = (packed: number): Rgb => [
  (packed >> RED_SHIFT) & BYTE_MASK,
  (packed >> GREEN_SHIFT) & BYTE_MASK,
  packed & BYTE_MASK,
];
// Attribute bits of the extracted cell array: bold, inverse, then the width.
const BOLD_BIT = 1;
const INVERSE_BIT = 2;
const WIDTH_SHIFT = 2;
const WIDE_BIT = 4;

// xterm's 256-color palette: its default theme for 0–15, then the standard cube and ramp.
const BASE16 =
  "2e3436 cc0000 4e9a06 c4a000 3465a4 75507b 06989a d3d7cf 555753 ef2929 8ae234 fce94f 729fcf ad7fa8 34e2e2 eeeeec"
    .split(" ")
    .map((hex) => Number.parseInt(hex, HEX));
// Cube levels: 0, then 95 + 40·n (xterm's 256colres.pl).
const CUBE_FIRST = 95;
const CUBE_STEP = 40;
const CUBE_START = 16;
const GRAY_START = 232;
const CUBE_SIDE = 6;
const GRAY_BASE = 8;
const GRAY_STEP = 10;
const BYTE = 256;
function palette256(index: number): Rgb {
  if (index < CUBE_START) {
    return rgbOf(BASE16[index] ?? 0);
  }
  if (index >= GRAY_START) {
    const v = GRAY_BASE + (index - GRAY_START) * GRAY_STEP;
    return [v, v, v];
  }
  const i = index - CUBE_START;
  const level = (n: number) => (n === 0 ? 0 : CUBE_FIRST + CUBE_STEP * (n - 1));
  return [
    level(Math.floor(i / (CUBE_SIDE * CUBE_SIDE))),
    level(Math.floor(i / CUBE_SIDE) % CUBE_SIDE),
    level(i % CUBE_SIDE),
  ];
}

// RGBA objects for OpenTUI's setCell, cached by packed color: allocation per cell would
// measure the garbage collector, not the drawing path.
const rgbaCache = new Map<number, RGBA>();
function rgba(r: number, g: number, b: number) {
  const key = pack(r, g, b);
  let value = rgbaCache.get(key);
  if (!value) rgbaCache.set(key, (value = RGBA.fromInts(r, g, b)));
  return value;
}
const WHITE = rgba(BYTE - 1, BYTE - 1, BYTE - 1);
const BLACK = rgba(0, 0, 0);

// --- @xterm/headless 6.0.0: pure JavaScript, the xterm.js parser and buffer. ----------------
export async function xterm(cols: number, rows: number): Promise<Emulator> {
  const term = new XtermTerminal({ cols, rows, allowProposedApi: true, scrollback: 1000 });
  // Unicode 15 widths and grapheme clusters ("15-graphemes", activated on load): with the
  // default Unicode 6 tables emoji are one cell wide and ZWJ sequences split.
  term.loadAddon(new UnicodeGraphemesAddon());
  let responses = "";
  term.onData((data) => (responses += data));
  let pending = Promise.resolve();
  const cells = { data: new Uint32Array(cols * rows * CELL_FIELDS) };
  const reuse = term.buffer.active.getNullCell();
  const cellAt = (x: number, y: number): Cell | undefined => {
    const buffer = term.buffer.active;
    const cell = buffer.getLine(buffer.viewportY + y)?.getCell(x);
    if (!cell) return undefined;
    const fg = cell.isFgRGB()
      ? rgbOf(cell.getFgColor())
      : cell.isFgPalette()
        ? palette256(cell.getFgColor())
        : undefined;
    // xterm keeps OSC 8 links internally (extended attributes) with no public accessor.
    return {
      text: cell.getChars(),
      width: cell.getWidth(),
      fg,
      bold: cell.isBold() !== 0,
      inverse: cell.isInverse() !== 0,
    };
  };
  return {
    name: "@xterm/headless",
    write(data) {
      pending = new Promise((done) => term.write(bytesOf(data), done));
    },
    settle: () => pending,
    resize(c, r) {
      term.resize(c, r);
      cells.data = new Uint32Array(c * r * CELL_FIELDS);
    },
    extract() {
      const buffer = term.buffer.active;
      let i = 0;
      for (let y = 0; y < term.rows; y++) {
        const line = buffer.getLine(buffer.viewportY + y);
        if (!line) continue;
        for (let x = 0; x < term.cols; x++) {
          const cell = line.getCell(x, reuse);
          if (!cell) continue;
          cells.data[i++] = cell.getCode();
          cells.data[i++] = cell.getFgColor();
          cells.data[i++] = cell.getBgColor();
          cells.data[i++] =
            (cell.isBold() ? BOLD_BIT : 0) |
            (cell.isInverse() ? INVERSE_BIT : 0) |
            (cell.getWidth() << WIDTH_SHIFT);
        }
      }
      return i / CELL_FIELDS;
    },
    draw(target) {
      const buffer = term.buffer.active;
      for (let y = 0; y < term.rows; y++) {
        const line = buffer.getLine(buffer.viewportY + y);
        if (!line) continue;
        for (let x = 0; x < term.cols; x++) {
          const cell = line.getCell(x, reuse);
          if (!cell || cell.getWidth() === 0) continue;
          const fg = cell.isFgDefault()
            ? WHITE
            : rgba(...(cell.isFgRGB() ? rgbOf(cell.getFgColor()) : palette256(cell.getFgColor())));
          const bg = cell.isBgDefault()
            ? BLACK
            : rgba(...(cell.isBgRGB() ? rgbOf(cell.getBgColor()) : palette256(cell.getBgColor())));
          const attributes =
            (cell.isBold() ? TextAttributes.BOLD : 0) |
            (cell.isInverse() ? TextAttributes.INVERSE : 0);
          target.setCell(x, y, cell.getChars() || " ", fg, bg, attributes);
        }
      }
    },
    async grid() {
      await pending;
      return {
        cell: cellAt,
        line: (y) =>
          term.buffer.active.getLine(term.buffer.active.viewportY + y)?.translateToString(true) ??
          "",
      };
    },
    async modes() {
      await pending;
      const tracking = term.modes.mouseTrackingMode;
      return {
        mouse: tracking !== "none",
        // The mouse encoding (SGR 1006) is internal to xterm's CoreMouseService.
        bracketedPaste: term.modes.bracketedPasteMode,
        decckm: term.modes.applicationCursorKeysMode,
        // DECSCUSR lands in xterm's internal decPrivateModes; `options.cursorStyle` is the
        // embedder's setting and never changes: no public API.
      };
    },
    takeResponses() {
      const out = responses;
      responses = "";
      return out;
    },
    dispose: () => term.dispose(),
  };
}

// --- ghostty-web 0.4.0: libghostty-vt compiled to WebAssembly (413 KB, no native code). -----
const MODE_DECCKM = 1;
const MODE_MOUSE_NORMAL = 1000;
const MODE_SGR_MOUSE = 1006;
const MODE_BRACKETED_PASTE = 2004;
const FLAG_BOLD = 1;
const FLAG_INVERSE = 16;
let shared: Promise<Ghostty> | undefined;
/**
 * One WebAssembly instance per terminal. Sharing one instance between terminals (the
 * library's intent) leaks cells of a freed terminal into the next one and ends in
 * "Out of bounds memory access" (0.4.0): see ghosttyWebShared and the isolation check.
 */
export async function ghosttyWeb(
  cols: number,
  rows: number,
  module?: Promise<Ghostty>,
): Promise<Emulator> {
  const term = (await (module ?? Ghostty.load())).createTerminal(cols, rows);
  const cells = { data: new Uint32Array(cols * rows * CELL_FIELDS) };
  let cursorStyle: string | undefined;
  return {
    name: "ghostty-web (wasm)",
    write: (data) => term.write(bytesOf(data)),
    settle: async () => {},
    resize(c, r) {
      term.resize(c, r);
      cells.data = new Uint32Array(c * r * CELL_FIELDS);
    },
    extract() {
      term.update();
      const viewport = term.getViewport();
      let i = 0;
      for (const cell of viewport) {
        cells.data[i++] = cell.codepoint;
        cells.data[i++] = pack(cell.fg_r, cell.fg_g, cell.fg_b);
        cells.data[i++] = pack(cell.bg_r, cell.bg_g, cell.bg_b);
        cells.data[i++] = cell.flags | (cell.width << GREEN_SHIFT);
      }
      return viewport.length;
    },
    draw(target) {
      term.update();
      const viewport = term.getViewport();
      const width = term.cols;
      viewport.forEach((cell, i) => {
        if (cell.width === 0) return;
        const char = cell.codepoint ? String.fromCodePoint(cell.codepoint) : " ";
        const attributes =
          (cell.flags & FLAG_BOLD ? TextAttributes.BOLD : 0) |
          (cell.flags & FLAG_INVERSE ? TextAttributes.INVERSE : 0);
        target.setCell(
          i % width,
          Math.floor(i / width),
          char,
          rgba(cell.fg_r, cell.fg_g, cell.fg_b),
          rgba(cell.bg_r, cell.bg_g, cell.bg_b),
          attributes,
        );
      });
    },
    async grid() {
      term.update();
      cursorStyle = term.getCursor().style;
      const width = term.cols;
      const viewport = term.getViewport().map((cell, i) => {
        const x = i % width;
        const y = Math.floor(i / width);
        const text =
          cell.grapheme_len > 0
            ? term.getGraphemeString(y, x)
            : cell.codepoint
              ? String.fromCodePoint(cell.codepoint)
              : "";
        const link = cell.hyperlink_id
          ? (term.getHyperlinkUri(cell.hyperlink_id) ?? undefined)
          : undefined;
        const fg: Rgb = [cell.fg_r, cell.fg_g, cell.fg_b];
        return {
          text,
          width: cell.width,
          fg,
          bold: (cell.flags & FLAG_BOLD) !== 0,
          inverse: (cell.flags & FLAG_INVERSE) !== 0,
          link,
        };
      });
      return {
        cell: (x, y) => viewport[y * width + x],
        line: (y) =>
          viewport
            .slice(y * width, (y + 1) * width)
            .map((c) => (c.width === 0 ? "" : c.text || " "))
            .join("")
            .trimEnd(),
      };
    },
    async modes() {
      term.update();
      return {
        mouse: term.getMode(MODE_MOUSE_NORMAL),
        sgrMouse: term.getMode(MODE_SGR_MOUSE),
        bracketedPaste: term.getMode(MODE_BRACKETED_PASTE),
        decckm: term.getMode(MODE_DECCKM),
        cursorStyle: cursorStyle ?? term.getCursor().style,
      };
    },
    takeResponses() {
      let out = "";
      while (term.hasResponse()) out += term.readResponse() ?? "";
      return out;
    },
    dispose: () => term.free(),
  };
}

/** ghostty-web as documented: every terminal from one shared WebAssembly instance. */
export function ghosttyWebShared(cols: number, rows: number) {
  shared ??= Ghostty.load();
  return ghosttyWeb(cols, rows, shared);
}

// --- libghostty-vt 0.6.3: native libghostty-vt through bun:ffi (community binding). -------
export async function libghosttyVt(cols: number, rows: number): Promise<Emulator> {
  let responses = "";
  const term = new VtTerminal({
    cols,
    rows,
    maxScrollback: 1000,
    onWritePty: (bytes) => (responses += decoder.decode(bytes)),
  });
  const state = new RenderState();
  const cells = { data: new Uint32Array(cols * rows * CELL_FIELDS) };
  const palette = () => term.colors().palette;
  const resolve = (
    color: Rgb | { palette: number } | undefined,
    table: readonly Rgb[],
  ): Rgb | undefined =>
    color === undefined ? undefined : "palette" in color ? table[color.palette] : color;
  return {
    name: "libghostty-vt (ffi)",
    write: (data) => term.vtWrite(bytesOf(data)),
    settle: async () => {},
    resize(c, r) {
      term.resize(c, r);
      cells.data = new Uint32Array(c * r * CELL_FIELDS);
    },
    extract() {
      state.update(term);
      const size = state.size();
      let i = 0;
      for (let y = 0; y < size.rows; y++)
        state.forEachCell(y, (cell) => {
          cells.data[i++] = cell.text.codePointAt(0) ?? 0;
          const fg = cell.style?.fg;
          cells.data[i++] = fg === undefined ? 0 : "palette" in fg ? fg.palette : pack(...fg);
          const bg = cell.style?.bg;
          cells.data[i++] = bg === undefined ? 0 : "palette" in bg ? bg.palette : pack(...bg);
          cells.data[i++] =
            (cell.style?.bold ? BOLD_BIT : 0) |
            (cell.style?.inverse ? INVERSE_BIT : 0) |
            (cell.wide ? WIDE_BIT : 0);
        });
      state.markClean();
      return i / CELL_FIELDS;
    },
    draw(target) {
      state.update(term);
      const table = palette();
      const size = state.size();
      for (let y = 0; y < size.rows; y++)
        state.forEachCell(y, (cell) => {
          if (cell.isWideContinuation) return;
          const fg = resolve(cell.style?.fg, table);
          const bg = resolve(cell.style?.bg, table);
          const attributes =
            (cell.style?.bold ? TextAttributes.BOLD : 0) |
            (cell.style?.inverse ? TextAttributes.INVERSE : 0);
          target.setCell(
            cell.x,
            y,
            cell.text || " ",
            fg ? rgba(...fg) : WHITE,
            bg ? rgba(...bg) : BLACK,
            attributes,
          );
        });
      state.markClean();
    },
    async grid() {
      const table = palette();
      const snapshot = term.snapshot();
      return {
        cell(x, y) {
          const info = term.cellAt({ x, y });
          if (!info) return undefined;
          return {
            text: info.text,
            width: info.isWideContinuation ? 0 : info.wide ? 2 : 1,
            fg: resolve(info.style?.fg, table),
            bold: info.style?.bold ?? false,
            inverse: info.style?.inverse ?? false,
            link: info.hyperlinkUri,
          };
        },
        line(y) {
          let out = "";
          for (let x = 0; x < snapshot.cols; x++) {
            const info = term.cellAt({ x, y });
            if (info && !info.isWideContinuation) out += info.text || " ";
          }
          return out.trimEnd();
        },
      };
    },
    async modes() {
      return {
        mouse: term.mode("normal_mouse") || term.mode("button_mouse") || term.mode("any_mouse"),
        sgrMouse: term.mode("sgr_mouse"),
        bracketedPaste: term.mode("bracketed_paste"),
        decckm: term.mode("decckm"),
        // DECSCUSR is kept by libghostty but not exposed by this binding (0.6.3).
      };
    },
    takeResponses() {
      const out = responses;
      responses = "";
      return out;
    },
    dispose() {
      state.close();
      term.close();
    },
  };
}

// --- ghostty-opentui 1.5.0: Ghostty's parser behind N-API, made to render PTY logs. --------
export async function ghosttyOpentui(cols: number, rows: number): Promise<Emulator> {
  const term = new PersistentTerminal({ cols, rows });
  // Its only read API is JSON (merged spans with hex colors), built per call.
  const snapshot = () =>
    term.getJson({
      offset: Math.max(0, term.getJson({ limit: 1 }).totalLines - term.rows),
      limit: term.rows,
    });
  const hex = (value: string | null): Rgb | undefined => {
    if (!value) return undefined;
    const n = Number.parseInt(value.slice(1), 16);
    return rgbOf(n);
  };
  const BOLD = 1;
  const INVERSE = 16;
  return {
    name: "ghostty-opentui (napi)",
    write: (data) => term.feed(bytesOf(data)),
    settle: async () => {},
    resize: (c, r) => term.resize(c, r),
    extract: () =>
      snapshot().lines.reduce(
        (n, line) => n + line.spans.reduce((m, span) => m + span.width, 0),
        0,
      ),
    async grid() {
      const data = snapshot();
      const rowsOf = data.lines.map((line) => {
        const row: Cell[] = [];
        for (const span of line.spans)
          for (const { segment } of new Intl.Segmenter().segment(span.text)) {
            const width = Bun.stringWidth(segment);
            row.push({
              text: segment,
              width,
              fg: hex(span.fg),
              bold: (span.flags & BOLD) !== 0,
              inverse: (span.flags & INVERSE) !== 0,
            });
            for (let i = 1; i < width; i++)
              row.push({ text: "", width: 0, bold: false, inverse: false });
          }
        return row;
      });
      return {
        cell: (x, y) => rowsOf[y]?.[x],
        line: (y) =>
          (rowsOf[y] ?? [])
            .map((c) => c.text)
            .join("")
            .trimEnd(),
      };
    },
    // A log renderer: it keeps no mode an application could query, and answers nothing.
    modes: async () => ({}),
    takeResponses: () => undefined,
    dispose: () => term.destroy(),
  };
}

// --- OpenTUI 0.5.12 EmbeddedTerminalRenderable: libghostty-vt inside libopentui. --------
const INPUT_SETTLE_MS = 30;
const DEFAULT_FG: Rgb = [BYTE - 1, BYTE - 1, BYTE - 1];
const DEFAULT_BG: Rgb = [0, 0, 0];
const same = (a: readonly number[], b: readonly number[]) => a.every((v, i) => v === b[i]);
function cellsOf(frame: CapturedFrame) {
  return frame.lines.map((line) => {
    const row: Cell[] = [];
    for (const span of line.spans) {
      const [r, g, b] = span.fg.toInts();
      const [br, bg, bb] = span.bg.toInts();
      // libghostty resolves SGR 7 before composing: an inverse cell arrives with its
      // colors swapped (default fg as background), not with the INVERSE attribute.
      const swapped = same([r, g, b], DEFAULT_BG) && same([br, bg, bb], DEFAULT_FG);
      for (const { segment } of new Intl.Segmenter().segment(span.text)) {
        const width = Bun.stringWidth(segment);
        row.push({
          text: segment,
          width,
          fg: [r, g, b],
          bold: (span.attributes & TextAttributes.BOLD) !== 0,
          inverse: (span.attributes & TextAttributes.INVERSE) !== 0 || swapped,
        });
        for (let i = 1; i < width; i++)
          row.push({ text: "", width: 0, bold: false, inverse: false });
      }
    }
    return row;
  });
}
export async function opentuiEmbedded(cols: number, rows: number): Promise<Emulator> {
  const setup = await createTestRenderer({ width: cols, height: rows });
  let responses = "";
  const term = new EmbeddedTerminalRenderable(setup.renderer, {
    width: "100%",
    height: "100%",
    onData: (bytes, source) => {
      if (source === "response") responses += decoder.decode(bytes);
    },
  });
  setup.renderer.root.add(term);
  await setup.renderOnce();
  // Focused, so that renderSelf() publishes the cursor (style included) to the renderer.
  term.focus();
  let target = OptimizedBuffer.create(cols, rows, "unicode");
  // Bytes the renderable encodes for the next input action, captured from onData.
  const inputOf = async (act: () => unknown) => {
    const previous = term.onData;
    let input = "";
    term.onData = (bytes, source) => {
      if (source === "input") input += decoder.decode(bytes);
      else previous?.(bytes, source);
    };
    await act();
    await Bun.sleep(INPUT_SETTLE_MS);
    term.onData = previous;
    return input;
  };
  return {
    name: "OpenTUI EmbeddedTerminal (libghostty in libopentui)",
    write: (data) => term.write(data),
    settle: async () => {},
    resize(c, r) {
      setup.resize(c, r);
      target.destroy();
      target = OptimizedBuffer.create(c, r, "unicode");
    },
    // The renderable composes natively; there is no cell array to read: its "frame" cost
    // is a forced full composition into a buffer (invalidate + render).
    extract() {
      term.invalidate();
      term.render(target, 0);
      return target.width * target.height;
    },
    async grid() {
      await setup.renderOnce();
      const rowsOf = cellsOf(setup.captureSpans());
      return {
        cell(x, y) {
          const cell = rowsOf[y]?.[x];
          if (!cell) return undefined;
          return { ...cell, link: setup.renderer.getLinkAt(term.x + x, term.y + y) ?? undefined };
        },
        line: (y) =>
          (rowsOf[y] ?? [])
            .map((c) => c.text)
            .join("")
            .trimEnd(),
      };
    },
    async modes() {
      await setup.renderOnce();
      const paste = decoder.decode(term.encodePaste(new TextEncoder().encode("p")));
      const clicked = await inputOf(() => setup.mockMouse.click(term.x, term.y));
      const arrow = await inputOf(() => setup.mockInput.pressArrow("up"));
      return {
        // No mode getters: modes are observed through what the encoders produce.
        mouse: clicked.length > 0,
        sgrMouse: clicked.startsWith("\x1b[<"),
        bracketedPaste: paste.startsWith("\x1b[200~"),
        decckm: arrow === "\x1bOA",
        cursorStyle: setup.renderer.getCursorState().style,
      };
    },
    takeResponses() {
      const out = responses;
      responses = "";
      return out;
    },
    dispose() {
      target.destroy();
      setup.renderer.destroy();
    },
  };
}

export const EMULATORS = {
  "opentui-embedded": opentuiEmbedded,
  "libghostty-vt": libghosttyVt,
  "ghostty-web": ghosttyWeb,
  "xterm-headless": xterm,
  "ghostty-opentui": ghosttyOpentui,
} satisfies Record<string, (cols: number, rows: number) => Promise<Emulator>>;
export type EmulatorName = keyof typeof EMULATORS;
export const EMULATOR_NAMES = Object.keys(EMULATORS).filter(
  (name): name is EmulatorName => name in EMULATORS,
);
