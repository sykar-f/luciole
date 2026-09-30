// Plain functions shared by the Server and Client Components: no runtime.

const DAY_MS = 86_400_000;
const WEEK_DAYS = 7;
const time = new Intl.DateTimeFormat("en", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const weekday = new Intl.DateTimeFormat("en", { weekday: "long" });
const day = new Intl.DateTimeFormat("en", { day: "numeric", month: "short" });
const dayOfYear = new Intl.DateTimeFormat("en", {
  day: "numeric",
  month: "short",
  year: "numeric",
});
/** When a note last changed, as a notebook says it: 14:02 · Yesterday · Monday · Sep 3 · Sep 3, 2025. */
export function when(updated: number, now = Date.now()) {
  if (!updated) return "";
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  if (updated >= midnight) return time.format(updated);
  if (updated >= midnight - DAY_MS) return "Yesterday";
  if (updated >= midnight - (WEEK_DAYS - 1) * DAY_MS) return weekday.format(updated);
  const sameYear = new Date(updated).getFullYear() === new Date(now).getFullYear();
  return (sameYear ? day : dayOfYear).format(updated);
}
/** The first line with words in it, without its Markdown markers. */
export function excerptOf(value: string) {
  const line = value
    .split("\n")
    .map((l) => l.replace(/^\s*(#+|>|[-*+]|\d+\.|```\w*)\s*/, "").replace(/[*_`]/g, ""))
    .find((l) => l.trim());
  return line?.trim() ?? "No additional text";
}

const SIDEBAR_SHARE = 0.3;
const SIDEBAR_MIN = 26;
const SIDEBAR_MAX = 40;
/** The sidebar's width on a screen `columns` wide: 0 when folded away. */
export const sidebarWidth = (columns: number, open: boolean) =>
  open ? Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(columns * SIDEBAR_SHARE))) : 0;

/** `text` cut to `width` cells, an ellipsis marking the cut. */
export const fit = (text: string, width: number) =>
  text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
