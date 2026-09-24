// Palette shared by Server pages and Client Components (plain values, no runtime),
// the same as Forge so both demos read alike.
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
  violet: "#d2a8ff",
  orange: "#ffa657",
  panel: "#161b22",
  code: "#0f1720",
  selected: "#1f3b4d",
  border: "#30363d",
  skeleton: "#d6d6d6",
} as const;

const KIB = 1024;
export const bytes = (size: number) =>
  size < KIB
    ? `${size} B`
    : size < KIB * KIB
      ? `${(size / KIB).toFixed(1)} KB`
      : `${(size / KIB / KIB).toFixed(1)} MB`;
