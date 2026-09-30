// Plain functions shared by the Server and Client Components: no runtime.

const DAY_MS = 86_400_000;
const WEEK_DAYS = 7;
const time = new Intl.DateTimeFormat("en", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const day = new Intl.DateTimeFormat("en", { day: "numeric", month: "short" });
const shortWeekday = new Intl.DateTimeFormat("en", { weekday: "short" });
const monthOfYear = new Intl.DateTimeFormat("en", { month: "short", year: "numeric" });
/**
 * When a note last changed, in at most 8 cells, for a column of dates: 14:02 · Mon ·
 * Sep 3 · Sep 2025. Yesterday is its weekday there: a list reads "Mon" as easily.
 */
export function whenShort(updated: number, now = Date.now()) {
  if (!updated) return "";
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  if (updated >= midnight) return time.format(updated);
  if (updated >= midnight - (WEEK_DAYS - 1) * DAY_MS) return shortWeekday.format(updated);
  const sameYear = new Date(updated).getFullYear() === new Date(now).getFullYear();
  return (sameYear ? day : monthOfYear).format(updated);
}
/** A line's words, without its Markdown markers: "" when it has none. */
const wordsOf = (line: string) =>
  /[\p{L}\p{N}]/u.test(line)
    ? line
        .replace(/^\s*(#+|>|[-*+]|\d+\.|```\w*)\s*(\[[ xX]\]\s*)?/, "")
        .replace(/[*_`]/g, "")
        .trim()
    : "";
const isHeading = (line: string) => /^\s{0,3}#{1,6}(\s|$)/.test(line);
/**
 * The first line with words in it, without its Markdown markers. A heading mostly names
 * what follows, so the first line of text is preferred; a note of headings only shows one.
 */
export function excerptOf(value: string) {
  const lines = value.split("\n");
  const line =
    lines
      .filter((l) => !isHeading(l))
      .map(wordsOf)
      .find(Boolean) ?? lines.map(wordsOf).find(Boolean);
  return line ?? "No additional text";
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
