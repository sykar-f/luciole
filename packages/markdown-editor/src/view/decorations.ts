import type { Inline } from "../model/types.ts";

// What notes write beyond what the editor models, drawn at layout time over text kept as
// written: the Markdown is never changed, only how it reads. In the block being edited
// the syntax shows again, faint, to be edited as typed.

/** A piece of plain text: drawn as is, drawn as `shown`, or not drawn (`hidden`). */
export type Piece = {
  readonly text: string;
  /** Where the piece starts in the text it was cut from. */
  readonly at: number;
  readonly groups: readonly string[];
  /** Drawn instead of `text`, over its offsets. */
  readonly shown?: string;
  /** Syntax that is not drawn (only in the block being edited, faint). */
  readonly syntax?: boolean;
};

const EMOJI: Readonly<Record<string, string>> = {
  tada: "🎉",
  rocket: "🚀",
  fire: "🔥",
  sparkles: "✨",
  bulb: "💡",
  warning: "⚠️",
  white_check_mark: "✅",
  heavy_check_mark: "✔️",
  x: "❌",
  memo: "📝",
  pushpin: "📌",
  link: "🔗",
  lock: "🔒",
  key: "🔑",
  bug: "🐛",
  zap: "⚡",
  star: "⭐",
  heart: "❤️",
  eyes: "👀",
  thinking: "🤔",
  smile: "😄",
  wink: "😉",
  joy: "😂",
  cry: "😢",
  thumbsup: "👍",
  "+1": "👍",
  thumbsdown: "👎",
  "-1": "👎",
  clap: "👏",
  pray: "🙏",
  muscle: "💪",
  coffee: "☕",
  calendar: "📅",
  hourglass: "⌛",
  construction: "🚧",
  books: "📚",
  package: "📦",
  gear: "⚙️",
  question: "❓",
  exclamation: "❗",
  point_right: "👉",
  checkered_flag: "🏁",
};

const SUPERSCRIPT: Readonly<Record<string, string>> = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "+": "⁺",
  "-": "⁻",
  "=": "⁼",
  "(": "⁽",
  ")": "⁾",
  n: "ⁿ",
  i: "ⁱ",
};
const SUBSCRIPT: Readonly<Record<string, string>> = {
  "0": "₀",
  "1": "₁",
  "2": "₂",
  "3": "₃",
  "4": "₄",
  "5": "₅",
  "6": "₆",
  "7": "₇",
  "8": "₈",
  "9": "₉",
  "+": "₊",
  "-": "₋",
  "=": "₌",
  "(": "₍",
  ")": "₎",
};
/** `text` in superscript or subscript where Unicode has every character, else null. */
export function shifted(text: string, script: "sup" | "sub") {
  const table = script === "sup" ? SUPERSCRIPT : SUBSCRIPT;
  const chars = Array.from(text, (char) => table[char]);
  return chars.every((char) => char !== undefined) ? chars.join("") : null;
}

// `==highlight==`, a footnote reference `[^1]`, an emoji shortcode `:tada:`.
const DECORATED = /==(?=\S)([^=\n]+?)(?<=\S)==|\[\^([^\]\s]+)\](?!:)|:([a-z0-9_+-]+):/g;

/** Plain text cut into what is drawn as is and what is decorated. */
export function piecesOf(text: string): Piece[] {
  const pieces: Piece[] = [];
  let last = 0;
  for (const match of text.matchAll(DECORATED)) {
    const [whole, highlighted, footnote, emoji] = match;
    const at = match.index;
    const emojiShown = emoji === undefined ? undefined : EMOJI[emoji];
    if (emoji !== undefined && emojiShown === undefined) continue;
    if (at > last) pieces.push({ text: text.slice(last, at), at: last, groups: [] });
    if (highlighted !== undefined) {
      const inner = at + 2;
      pieces.push({ text: "==", at, groups: [], syntax: true });
      pieces.push({ text: highlighted, at: inner, groups: ["markup.highlight"] });
      pieces.push({ text: "==", at: inner + highlighted.length, groups: [], syntax: true });
    } else if (footnote !== undefined) {
      const sup = shifted(footnote, "sup");
      pieces.push({
        text: whole,
        at,
        groups: ["markup.link"],
        shown: sup ?? `[${footnote}]`,
      });
    } else if (emojiShown !== undefined) {
      pieces.push({ text: whole, at, groups: [], shown: emojiShown });
    }
    last = at + whole.length;
  }
  if (last < text.length) pieces.push({ text: text.slice(last), at: last, groups: [] });
  return pieces;
}

/** An inline HTML tag the editor draws: its name, and whether it closes. */
export function tagOf(source: string) {
  const tag = /^<(\/?)(kbd|mark|u|ins|sub|sup|small)\s*>$/i.exec(source);
  if (tag) return { name: (tag[2] ?? "").toLowerCase(), closing: tag[1] === "/" };
  return null;
}
export const isLineBreakTag = (source: string) => /^<br\s*\/?>$/i.test(source);
export const isComment = (source: string) => /^<!--[\s\S]*-->$/.test(source);

/** The style groups text inside open tags takes. */
export function tagGroups(open: readonly string[]): string[] {
  return open.flatMap((name) =>
    name === "kbd"
      ? ["markup.kbd"]
      : name === "mark"
        ? ["markup.highlight"]
        : name === "u" || name === "ins"
          ? ["markup.underline"]
          : name === "small" || name === "sub" || name === "sup"
            ? ["markup.footnote"]
            : [],
  );
}

export type AlertKind = "note" | "tip" | "important" | "warning" | "caution";
const ALERTS: Readonly<Record<AlertKind, string>> = {
  note: "◉ Note",
  tip: "✦ Tip",
  important: "❖ Important",
  warning: "⚠ Warning",
  caution: "⊘ Caution",
};
const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?=\n|$)/i;

/** GitHub's alert marker opening a quote's first paragraph: its kind, its title, its length. */
export function alertOf(content: Inline) {
  const first = content[0];
  if (!first || first.marks.code || first.marks.verbatim) return null;
  const match = ALERT.exec(first.text);
  const kind = match?.[1]?.toLowerCase();
  if (!match || !isAlertKind(kind)) return null;
  return { kind, title: ALERTS[kind], length: match[0].length };
}
const isAlertKind = (kind: string | undefined): kind is AlertKind =>
  kind !== undefined && kind in ALERTS;

const FOOTNOTE = /^\[\^([^\]\s]+)\]:[ \t]*/;
/** A footnote's definition opening a paragraph: its label shown, and the marker's length. */
export function footnoteOf(content: Inline) {
  const first = content[0];
  if (!first || first.marks.code || first.marks.verbatim) return null;
  const match = FOOTNOTE.exec(first.text);
  if (!match) return null;
  const label = match[1] ?? "";
  return { shown: `${shifted(label, "sup") ?? `[${label}]`} `, length: match[0].length };
}
