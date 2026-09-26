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

// The text of a frame, for screen readers and search engines.
export function text(frame: Frame) {
  return frame.cells
    .map((runs) =>
      runs
        .map(([t]) => t)
        .join("")
        .trimEnd(),
    )
    .join("\n")
    .trim();
}

export function escape(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The terminal's default colours, as the live demos set them (LiveTerminal.astro). */
export const SCREEN_BACKGROUND = "#0a0f16";
export const SCREEN_FOREGROUND = "#e6edf3";

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
