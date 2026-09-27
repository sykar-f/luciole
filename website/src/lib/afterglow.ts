// How brightly written cells glow. A renderer that rewrites a few cells shows them hot; one
// that rewrites half the screen (a diff streaming in, a page change) would bury it under a
// block of green, so the glow dims, and shortens, as the share of rewritten cells grows.

/** Up to this share of the screen, written cells glow at full strength. */
const CALM_SHARE = 0.04;
/** However much changes, the glow keeps this much, so a redraw still shows. */
const FAINTEST = 0.15;

/** The glow's strength, from 0 to 1, for `cells` written out of `total`. */
export function strength(cells: number, total: number) {
  const share = total ? cells / total : 0;
  if (share <= CALM_SHARE) return 1;
  return Math.max(FAINTEST, Math.sqrt(CALM_SHARE / share));
}

/** `color` at `amount` of its strength over `ground`, both `#rrggbb`. */
export function dim(color: string, ground: string, amount: number) {
  const channel = (hex: string, at: number) => Number.parseInt(hex.slice(at, at + 2), 16);
  return `#${[1, 3, 5]
    .map((at) => Math.round(channel(ground, at) + (channel(color, at) - channel(ground, at)) * amount))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}
