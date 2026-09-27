// The palette's colours, put into bytes built with stand-ins (lib/frames.ts): read from
// the page's tokens when they are written, so a terminal follows the preset in use.
import { dim, strength } from "./afterglow";
import { hex } from "./colour";

/** `r;g;b` of each stand-in, as it appears after `38;2;` or `48;2;`. */
const STAND_INS = { "1;2;3": "background", "1;2;4": "foreground", "1;2;5": "hot", "1;2;6": "warm" } as const;
type Role = (typeof STAND_INS)[keyof typeof STAND_INS];

const channels = (hex: string) =>
  [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)).join(";");

/** The screen's colours in the current palette, as `#rrggbb`. */
export function screenColours() {
  const style = getComputedStyle(document.documentElement);
  const share = (name: string) => Number.parseFloat(style.getPropertyValue(name)) / 100 || 0;
  return {
    background: hex("--screen"),
    foreground: hex("--screen-fg"),
    afterglow: hex("--afterglow"),
    hot: share("--afterglow-hot"),
    warm: share("--afterglow-warm"),
  };
}

/**
 * `ansi` with its stand-ins replaced by the palette's colours. `written` of `total` cells:
 * how much of the screen the bytes rewrite, which dims their afterglow (lib/afterglow.ts).
 */
export function recolor(ansi: string, written = 0, total = 1) {
  const colours = screenColours();
  const glow = strength(written, total);
  const values: Record<Role, string> = {
    background: colours.background,
    foreground: colours.foreground,
    hot: dim(colours.afterglow, colours.background, colours.hot * glow),
    warm: dim(colours.afterglow, colours.background, colours.warm * glow),
  };
  return ansi.replace(/([34]8;2;)(1;2;[3-6])(?=[;m])/g, (_, lead: string, stand: keyof typeof STAND_INS) =>
    `${lead}${channels(values[STAND_INS[stand]])}`,
  );
}
