// Palette shared with Forge, and the number formats of the usage counters. Plain values:
// Server pages and Client Components both import them.
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
  user: "#d2a8ff",
  selected: "#1f3b4d",
  border: "#30363d",
  skeleton: "#d6d6d6",
} as const;

const THOUSAND = 1000,
  MILLION = 1_000_000,
  CENT = 0.01;
/** 842 · 12.4k · 1.3M */
export function tokens(count: number) {
  if (count < THOUSAND) return String(count);
  if (count < MILLION) return `${(count / THOUSAND).toFixed(1)}k`;
  return `${(count / MILLION).toFixed(1)}M`;
}
/** US dollars with two significant digits under a cent: $0.00031 · $0.42 */
export function usd(amount: number) {
  if (amount === 0) return "$0";
  return amount < CENT ? `$${amount.toPrecision(2)}` : `$${amount.toFixed(2)}`;
}
/** A per-token list price, read per million tokens: $0.10/M */
export const perMillion = (price: number) => `$${(price * MILLION).toFixed(2)}/M`;
export const seconds = (ms: number) => `${(ms / THOUSAND).toFixed(1)}s`;
