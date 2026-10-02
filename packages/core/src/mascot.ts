// The mascot `luciole init` greets with: the small drawing (website/design/mascot/small/) in
// half blocks, one "▀" per cell with the upper pixel as foreground and the lower one as
// background, in 24-bit colour. Only for a person at a colour terminal: never in pipes, CI,
// NO_COLOR, or terminals without 24-bit colour.
import { MASCOT_PALETTE, MASCOT_PIXELS } from "./mascot-sprite.gen";

type Rgb = readonly [number, number, number];

const PIXEL_KEYS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const OPAQUE = 255;
const HEX = 16;
/** Where each channel starts in "#rrggbbaa". */
const AT = { red: 1, green: 3, blue: 5, alpha: 7 };
const RESET = "\x1b[0m";

const channel = (hex: string, at: number) => Number.parseInt(hex.slice(at, at + 2), HEX);
const rgb = (hex: string): Rgb => [
  channel(hex, AT.red),
  channel(hex, AT.green),
  channel(hex, AT.blue),
];

/** The glow is translucent: it is flattened onto the site's night. */
const NIGHT = rgb("#0b0a07");

function colour(key: string): Rgb | undefined {
  const hex = MASCOT_PALETTE[PIXEL_KEYS.indexOf(key)];
  if (!hex) return undefined;
  const alpha = channel(hex, AT.alpha) / OPAQUE;
  const [r, g, b] = rgb(hex);
  return [
    Math.round(r * alpha + NIGHT[0] * (1 - alpha)),
    Math.round(g * alpha + NIGHT[1] * (1 - alpha)),
    Math.round(b * alpha + NIGHT[2] * (1 - alpha)),
  ];
}

const fg = ([r, g, b]: Rgb) => `\x1b[38;2;${r};${g};${b}m`;
const bg = ([r, g, b]: Rgb) => `\x1b[48;2;${r};${g};${b}m`;

/** The mascot as terminal lines: 30 columns by about 20 rows. Transparent cells stay blank. */
export function mascotArt(): string {
  const lines: string[] = [];
  for (let y = 0; y < MASCOT_PIXELS.length; y += 2) {
    const upper = MASCOT_PIXELS[y] ?? "";
    const lower = MASCOT_PIXELS[y + 1] ?? "";
    let line = "";
    for (let x = 0; x < upper.length; x++) {
      const top = colour(upper[x] ?? ".");
      const bottom = colour(lower[x] ?? ".");
      if (top && bottom) line += `${fg(top)}${bg(bottom)}▀${RESET}`;
      else if (top) line += `${fg(top)}▀${RESET}`;
      else if (bottom) line += `${fg(bottom)}▄${RESET}`;
      else line += " ";
    }
    lines.push(line.trimEnd());
  }
  // The sprite's transparent margin (room for its glow) leaves blank rows at the edges.
  while (lines[0] === "") lines.shift();
  while (lines.at(-1) === "") lines.pop();
  return lines.join("\n");
}

/** Whether to draw it: a person at a 24-bit colour terminal, and nobody asked for plain output. */
export function canGreet(
  stream: { isTTY?: boolean },
  env: Record<string, string | undefined>,
): boolean {
  if (!stream.isTTY || env.NO_COLOR || env.CI) return false;
  return env.COLORTERM === "truecolor" || env.COLORTERM === "24bit";
}
