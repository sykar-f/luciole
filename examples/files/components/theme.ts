import type { Entry } from "./model";

// Palette shared by Server pages and Client Components (plain values, no runtime).
export const color = {
  accent: "#67d9bc",
  text: "#e6edf3",
  muted: "#8b98a5",
  faint: "#4a5561",
  warn: "#ffbc66",
  danger: "#ff7b72",
  ok: "#7ee787",
  info: "#79c0ff",
  violet: "#d2a8ff",
  panel: "#161b22",
  selected: "#1f3b4d",
  border: "#30363d",
  skeleton: "#d6d6d6",
} as const;

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const CODE = /\.(tsx?|jsx?|mjs|cjs|json|md|zig|py|rs|go|rb|sh|css|html|toml|ya?ml|sql|c|h|cpp)$/i;

/** One glyph and one colour per row, all single-width. */
export function glyphOf(entry: Entry): { glyph: string; fg: string } {
  const kind = entry.kind === "symlink" ? entry.targetKind : entry.kind;
  if (entry.kind === "symlink") return { glyph: "↪", fg: kind ? color.info : color.danger };
  if (kind === "directory") return { glyph: "▸", fg: color.info };
  if (kind === "other") return { glyph: "◇", fg: color.warn };
  if (IMAGE.test(entry.name)) return { glyph: "▣", fg: color.violet };
  if (CODE.test(entry.name)) return { glyph: "≡", fg: color.ok };
  return { glyph: "·", fg: color.muted };
}
