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
