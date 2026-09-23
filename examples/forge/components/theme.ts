// Palette shared by Server pages and Client Components (plain values, no runtime).
export const color = {
  accent: "#67d9bc",
  accentDim: "#2f6f5f",
  text: "#e6edf3",
  muted: "#8b98a5",
  faint: "#4a5561",
  warn: "#ffbc66",
  danger: "#ff7b72",
  ok: "#7ee787",
  info: "#79c0ff",
  panel: "#161b22",
  selected: "#1f3b4d",
  border: "#30363d",
  focus: "#526d82",
  skeleton: "#d6d6d6",
} as const;

export const stateColor = { open: color.ok, merged: "#d2a8ff", closed: color.danger } as const;
export const checkGlyph = {
  queued: "○",
  running: "◐",
  success: "✓",
  failure: "✗",
} as const;
export const checkColor = {
  queued: color.muted,
  running: color.warn,
  success: color.ok,
  failure: color.danger,
} as const;

const MINUTE_MS = 60_000,
  MINUTES_PER_HOUR = 60,
  HOURS_PER_DAY = 24;
// Under two days an age reads in hours, then in days.
const HOURS_SHOWN = 2 * HOURS_PER_DAY;
export const ago = (at: number, now: number) => {
  const minutes = Math.max(0, Math.round((now - at) / MINUTE_MS));
  if (minutes < 1) return "just now";
  if (minutes < MINUTES_PER_HOUR) return `${minutes} min ago`;
  const hours = Math.round(minutes / MINUTES_PER_HOUR);
  return hours < HOURS_SHOWN ? `${hours} h ago` : `${Math.round(hours / HOURS_PER_DAY)} d ago`;
};
