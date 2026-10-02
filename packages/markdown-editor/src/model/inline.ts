import { graphemes } from "./text.ts";
import type { Inline, MarkName, Marks, Span } from "./types.ts";

// Operations on a block's text as runs of marked text. Every function returns a
// normalized Inline: no empty run, neighbours with equal marks merged.

const KEYS = ["bold", "italic", "strike", "code", "link", "title", "verbatim", "escaped"] as const;

export const NO_MARKS: Marks = {};

export function sameMarks(a: Marks, b: Marks) {
  return KEYS.every((key) => a[key] === b[key]);
}
/** `marks` without the keys whose value is undefined, so equal marks look equal. */
export function cleanMarks(marks: Marks): Marks {
  return {
    ...(marks.bold ? { bold: true } : {}),
    ...(marks.italic ? { italic: true } : {}),
    ...(marks.strike ? { strike: true } : {}),
    ...(marks.code ? { code: true } : {}),
    ...(marks.link === undefined ? {} : { link: marks.link }),
    ...(marks.link === undefined || marks.title === undefined ? {} : { title: marks.title }),
    ...(marks.verbatim ? { verbatim: true } : {}),
    ...(marks.escaped ? { escaped: true } : {}),
  };
}
export function withMark(marks: Marks, mark: MarkName, on: boolean): Marks {
  return cleanMarks({ ...marks, [mark]: on ? true : undefined });
}

export function normalize(spans: readonly Span[]): Inline {
  const out: Span[] = [];
  for (const span of spans) {
    if (!span.text) continue;
    const last = out.at(-1);
    if (last && sameMarks(last.marks, span.marks))
      out[out.length - 1] = { text: last.text + span.text, marks: last.marks };
    else out.push({ text: span.text, marks: cleanMarks(span.marks) });
  }
  return out;
}

export const plain = (text: string, marks: Marks = NO_MARKS): Inline =>
  normalize([{ text, marks }]);

export const textOf = (inline: Inline) => inline.map((span) => span.text).join("");
export const lengthOf = (inline: Inline) =>
  inline.reduce((length, span) => length + span.text.length, 0);

/** The runs between `from` and `to`. */
export function slice(inline: Inline, from: number, to = Infinity): Inline {
  const out: Span[] = [];
  let at = 0;
  for (const span of inline) {
    const end = at + span.text.length;
    if (end > from && at < to)
      out.push({
        text: span.text.slice(Math.max(0, from - at), Math.min(span.text.length, to - at)),
        marks: span.marks,
      });
    at = end;
  }
  return normalize(out);
}

export const concat = (...parts: readonly Inline[]): Inline => normalize(parts.flat());

/** `inline` with `from`..`to` replaced by `insert`. */
export const splice = (inline: Inline, from: number, to: number, insert: Inline = []): Inline =>
  concat(slice(inline, 0, from), insert, slice(inline, to));

/** Marks that end where their text ends: typing after them is not typing in them. */
const ENDING = {
  link: undefined,
  title: undefined,
  code: undefined,
  verbatim: undefined,
  escaped: undefined,
};

/**
 * The marks text typed at `offset` takes: those of the character before it, except a
 * link or code, which end where they end (typing after a link is not typing in it).
 * At the start of a block, the marks of the first character.
 */
export function marksAt(inline: Inline, offset: number): Marks {
  let at = 0;
  for (const span of inline) {
    const end = at + span.text.length;
    if (offset > at && offset <= end) {
      if (offset < end) return span.marks;
      return cleanMarks({ ...span.marks, ...ENDING });
    }
    at = end;
  }
  const first = inline[0];
  return first && offset === 0 ? cleanMarks({ ...first.marks, ...ENDING }) : NO_MARKS;
}

/** Whether every character of `from`..`to` has `mark`. An empty range reads `marksAt`. */
export function hasMark(inline: Inline, from: number, to: number, mark: MarkName) {
  if (from === to) return marksAt(inline, from)[mark] === true;
  return slice(inline, from, to).every((span) => span.marks[mark] === true);
}

/** Sets or clears `mark` over `from`..`to`. */
export function setMark(inline: Inline, from: number, to: number, mark: MarkName, on: boolean) {
  const middle = slice(inline, from, to).map((span) => ({
    text: span.text,
    marks: withMark(span.marks, mark, on),
  }));
  return splice(inline, from, to, middle);
}

/** Links `from`..`to` to `href`, or unlinks it. */
export function setLink(
  inline: Inline,
  from: number,
  to: number,
  href: string | undefined,
  title?: string,
) {
  const middle = slice(inline, from, to).map((span) => ({
    text: span.text,
    marks: cleanMarks({ ...span.marks, link: href, title }),
  }));
  return splice(inline, from, to, middle);
}

/** The run holding `offset` (the one after it at a boundary), with where it starts. */
export function spanAt(inline: Inline, offset: number): { span: Span; start: number } | null {
  let at = 0;
  for (const span of inline) {
    const end = at + span.text.length;
    if (offset >= at && offset < end) return { span, start: at };
    at = end;
  }
  return null;
}

/** The extent of the link around `offset`, if the character after it is linked. */
export function linkAround(inline: Inline, offset: number) {
  const found = spanAt(inline, offset);
  const href = found?.span.marks.link;
  if (!found || href === undefined) return null;
  let from = found.start;
  let to = found.start + found.span.text.length;
  let at = 0;
  const spans = inline.map((span) => {
    const start = at;
    at += span.text.length;
    return { span, start, end: at };
  });
  for (const each of spans.toReversed())
    if (each.end === from && each.span.marks.link === href) from = each.start;
  for (const each of spans) if (each.start === to && each.span.marks.link === href) to = each.end;
  return { from, to, href };
}

/**
 * `inline` as it is drawn, as a string to compare: each character with its marks, spaces
 * without any (a space at the edge of bold text reads the same outside it), escapes as
 * plain text, the edges of each line trimmed.
 */
export function drawnKey(inline: Inline, options: { heading?: boolean } = {}) {
  const chars = inline.flatMap((span) =>
    graphemes(options.heading ? span.text.replaceAll("\n", " ") : span.text).map(
      ({ text: char }) => {
        const { escaped: _, ...marks } = span.marks;
        return { text: char, marks: /\s/.test(char) && !marks.code ? {} : marks };
      },
    ),
  );
  return JSON.stringify(
    normalize(chars)
      .map((span, i, all) => ({
        text: span.text
          .replace(i === 0 ? /^\s+/ : /(?!)/, "")
          .replace(i === all.length - 1 ? /\s+$/ : /(?!)/, "")
          .replace(/[ \t]*\n[ \t]*/g, "\n"),
        marks: span.marks,
      }))
      .filter((span) => span.text),
  );
}
