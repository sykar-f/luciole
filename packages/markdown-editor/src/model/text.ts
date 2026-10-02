// Characters as a terminal draws them: graphemes (a flag, an accented letter, an emoji
// with its modifiers are one), each one or two cells wide.

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
// Written as escapes in strings: the ranges hold invisible characters. A pictograph is wide
// when it is drawn as an emoji (`😀`, or `©` followed by U+FE0F); `©` alone is text.
const WIDE = new RegExp(
  "\\p{Emoji_Presentation}|\\p{Extended_Pictographic}\\uFE0F|[\\u1100-\\u115F\\u2E80-\\u303E\\u3041-\\u33FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uA000-\\uA4CF\\uAC00-\\uD7A3\\uF900-\\uFAFF\\uFE30-\\uFE4F\\uFF00-\\uFF60\\uFFE0-\\uFFE6]",
  "u",
);
const ZERO = new RegExp("^(?:\\p{M}|[\\u200B-\\u200F])+$", "u");

/** How many cells `grapheme` covers: 0, 1 or 2. */
export function cellWidth(grapheme: string) {
  if (!grapheme || ZERO.test(grapheme)) return 0;
  return WIDE.test(grapheme) ? 2 : 1;
}

/** `text`'s graphemes, with the offset each one starts at. */
export function graphemes(text: string): { text: string; offset: number }[] {
  return [...segmenter.segment(text)].map((s) => ({ text: s.segment, offset: s.index }));
}

/** The offset one grapheme after `offset` (or `offset` at the end). */
export function nextBoundary(text: string, offset: number) {
  for (const g of graphemes(text)) if (g.offset > offset) return g.offset;
  return text.length;
}
/** The offset one grapheme before `offset` (or 0). */
export function previousBoundary(text: string, offset: number) {
  let last = 0;
  for (const g of graphemes(text)) {
    if (g.offset >= offset) break;
    last = g.offset;
  }
  return last;
}

const WORD = /[\p{L}\p{N}_]/u;
const isWord = (char: string) => WORD.test(char);

/** Where the next word ends, from `offset`: spaces and punctuation are skipped first. */
export function wordEnd(text: string, offset: number) {
  let at = offset;
  while (at < text.length && !isWord(text[at] ?? "")) at++;
  while (at < text.length && isWord(text[at] ?? "")) at++;
  return at;
}
/** Where the previous word starts, from `offset`. */
export function wordStart(text: string, offset: number) {
  let at = offset;
  while (at > 0 && !isWord(text[at - 1] ?? "")) at--;
  while (at > 0 && isWord(text[at - 1] ?? "")) at--;
  return at;
}
/** The word around `offset`, for a double click: empty between two non-words. */
export function wordAround(text: string, offset: number) {
  let from = offset;
  let to = offset;
  while (from > 0 && isWord(text[from - 1] ?? "")) from--;
  while (to < text.length && isWord(text[to] ?? "")) to++;
  return { from, to };
}
export const isWordChar = isWord;
