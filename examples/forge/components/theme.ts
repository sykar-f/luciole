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

export const ago = (at: number, now: number) => {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
};
