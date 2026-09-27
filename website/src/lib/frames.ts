// Screens captured from the example applications by scripts/capture.py.
export type Run = [text: string, fg: string | null, bg: string | null, flags: string];
export type Frame = { title: string; cols: number; rows: number; cells: Run[][] };

const files = import.meta.glob<Frame>("../frames/*.json", { eager: true, import: "default" });

export function frame(name: string): Frame {
  const found = files[`../frames/${name}.json`];
  if (!found) throw new Error(`No captured frame ${name}: run scripts/capture.py`);
  return found;
}

// pyte names the 16 ANSI colours; OpenTUI apps send truecolor, so these are fallbacks.
const named: Record<string, string> = {
  black: "#1b2230",
  red: "#ff7b72",
  green: "#7ee787",
  brown: "#e3b341",
  yellow: "#e3b341",
  blue: "#79c0ff",
  magenta: "#d2a8ff",
  cyan: "#56d4dd",
  white: "#e6edf3",
};

// A reversed cell swaps in the terminal's own colours, which the page defines.
function paint(value: string | null) {
  if (value === null) return null;
  if (value === "fg") return "var(--screen-fg)";
  if (value === "bg") return "var(--screen)";
  if (value.startsWith("#")) return value;
  return named[value.replace(/^bright/, "")] ?? null;
}

export function style([, fg, bg, flags]: Run) {
  const rules: string[] = [];
  const color = paint(fg);
  const background = paint(bg);
  if (color) rules.push(`color:${color}`);
  if (background) rules.push(`background:${background}`);
  if (flags.includes("b")) rules.push("font-weight:700");
  if (flags.includes("i")) rules.push("font-style:italic");
  if (flags.includes("u")) rules.push("text-decoration:underline");
  return rules.join(";");
}

/** The text of each row, without its trailing blanks. */
export const lines = (frame: Frame) =>
  frame.cells.map((runs) =>
    runs
      .map(([t]) => t)
      .join("")
      .trimEnd(),
  );

// The text of a frame, for screen readers and search engines.
export function text(frame: Frame) {
  return lines(frame).join("\n").trim();
}

export function escape(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Stand-ins, in the bytes built here, for colours the palette decides in the page: the
 * screen's own background and text (a reversed cell takes them), and the afterglow of a
 * freshly written cell, hot then warm. LiveTerminal.astro puts the palette's in with
 * `recolor` before writing. No application sends these values.
 */
export const SCREEN_BACKGROUND = "#010203";
export const SCREEN_FOREGROUND = "#010204";
export const GLOW_HOT = "#010205";
export const GLOW_WARM = "#010206";

const HEX = 16;
/** Where red, green and blue start in `#rrggbb`. */
const RED = 1;
const GREEN = 3;
const BLUE = 5;
const CHANNELS = [RED, GREEN, BLUE];
const rgb = (hex: string) =>
  CHANNELS.map((i) => Number.parseInt(hex.slice(i, i + 2), HEX)).join(";");
/** A captured colour as a hex value; the terminal's own for a reversed cell. */
function hexOf(value: string | null) {
  if (value === null) return null;
  if (value === "fg") return SCREEN_FOREGROUND;
  if (value === "bg") return SCREEN_BACKGROUND;
  if (value.startsWith("#")) return value;
  return named[value.replace(/^bright/, "")] ?? null;
}

/**
 * A frame as the bytes a terminal would receive to draw it: what a live demo's static
 * stand-in, an xterm.js of its own, writes before the application replaces it.
 */
export function ansi(frame: Frame) {
  const ESC = "\x1b[";
  const rows = frame.cells.map((runs) =>
    runs
      .map((run) => {
        const [text, fg, bg, flags] = run;
        const codes = ["0"];
        const color = hexOf(fg);
        const background = hexOf(bg);
        if (color) codes.push(`38;2;${rgb(color)}`);
        if (background) codes.push(`48;2;${rgb(background)}`);
        if (flags.includes("b")) codes.push("1");
        if (flags.includes("i")) codes.push("3");
        if (flags.includes("u")) codes.push("4");
        return `${ESC}${codes.join(";")}m${text}`;
      })
      .join(""),
  );
  // Cursor hidden, as OpenTUI hides it; rows placed absolutely, so none scrolls.
  return `${ESC}?25l${rows.map((row, i) => `${ESC}${i + 1};1H${row}${ESC}0m`).join("")}`;
}

/** One cell: its character and the style it was drawn with. */
type Cell = [text: string, fg: string | null, bg: string | null, flags: string];

/** A frame as a grid of cells, blanks included: rows are captured without their trailing ones. */
function grid(frame: Frame): Cell[][] {
  return frame.cells.map((runs) => {
    // A cell per code point, as pyte stored them (scripts/capture.py): not graphemes.
    const cells: Cell[] = runs.flatMap(([text, fg, bg, flags]) =>
      Array.from(text, (char): Cell => [char, fg, bg, flags]),
    );
    while (cells.length < frame.cols) cells.push([" ", null, null, ""]);
    return cells;
  });
}

const same = (a: Cell, b: Cell) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
const blank = ([char, , bg]: Cell) => char === " " && bg === null;

/**
 * What a terminal renderer writes to go from `before` to `after` (from an empty screen
 * without one): the cells that changed, and only those, as the bytes that draw them.
 * With `tint`, each is drawn on that background instead of its own: the afterglow of a
 * freshly written cell. Returns the bytes and how many cells they write.
 */
export function patch(before: Frame | null, after: Frame, tint?: string) {
  const ESC = "\x1b[";
  const old = before ? grid(before) : [];
  let cells = 0;
  const writes = grid(after).map((row, y) => {
    let out = "";
    let at = -1;
    row.forEach((cell, x) => {
      const previous = old[y]?.[x];
      if (previous ? same(previous, cell) : blank(cell)) return;
      cells++;
      const [text, fg, bg, flags] = cell;
      const codes = ["0"];
      const color = hexOf(fg);
      const background = tint ?? hexOf(bg);
      if (color) codes.push(`38;2;${rgb(color)}`);
      if (background) codes.push(`48;2;${rgb(background)}`);
      if (flags.includes("b")) codes.push("1");
      if (flags.includes("i")) codes.push("3");
      if (flags.includes("u")) codes.push("4");
      if (at !== x) out += `${ESC}${y + 1};${x + 1}H`;
      out += `${ESC}${codes.join(";")}m${text}`;
      at = x + 1;
    });
    return out;
  });
  return { ansi: `${ESC}?25l${writes.join("")}${ESC}0m`, cells };
}
