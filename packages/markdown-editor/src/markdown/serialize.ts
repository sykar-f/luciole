import { joins, listNumber } from "../model/doc.ts";
import { REFERENCE_START } from "../model/entities.ts";
import {
  isLines,
  isText,
  quoteOf,
  type Block,
  type Doc,
  type Inline,
  type Marks,
} from "../model/types.ts";
import { drawnKey } from "../model/inline.ts";
import { parseMarkdown } from "./parse.ts";

// A document to Markdown. Blocks read from Markdown and left untouched are written back
// exactly as they were (in their quotes and lists); the others in one canonical form: `-`
// bullets, `**` and `*`, fenced code. Every delimiter opened is closed: the Markdown is
// balanced by construction, whatever the editing did.

const BULLET = "- ";
const FENCE = 3;

export function serializeMarkdown(written: Doc): string {
  // An empty paragraph outside quotes has no Markdown: blank lines are all one.
  const doc = written.filter(
    (block, i) =>
      written.length === 1 ||
      i === 0 ||
      !(block.type === "paragraph" && !block.content.length && !block.quote && !block.depth),
  );
  // The width of each open list level's marker, so nested text lines up with its item's,
  // and whether its list is loose, for what its items hold.
  const markers: number[] = [];
  let out = "";
  doc.forEach((block, index) => {
    const previous = doc[index - 1];
    const depth = block.type === "item" ? 0 : (block.depth ?? 0);
    out += separator(doc, index);
    // A list goes on only in the same quotes.
    if (previous && quoteOf(previous) !== quoteOf(block)) markers.length = 0;
    const quote = "> ".repeat(quoteOf(block));
    if (block.type === "item") {
      markers.length = Math.min(markers.length, block.indent);
      while (markers.length < block.indent) markers.push(BULLET.length);
      const indent = " ".repeat(sum(markers));
      const bullet = bulletOf(doc, index, block);
      const marker = block.list === "task" ? `${bullet}[${block.checked ? "x" : " "}] ` : bullet;
      markers.push(bullet.length);
      const rest = `${quote}${indent}${" ".repeat(bullet.length)}`;
      out += prefix(bodyOf(block), `${quote}${indent}${marker}`, rest, { exact: false });
      return;
    }
    markers.length = Math.min(markers.length, depth);
    while (markers.length < depth) markers.push(BULLET.length);
    const lead = `${quote}${" ".repeat(sum(markers))}`;
    // Markdown kept as read keeps its trailing spaces: two of them are a line break.
    out += prefix(bodyOf(block), lead, lead, {
      exact: isLines(block) || block.source !== undefined,
    });
  });
  return out.replace(/\s+$/, "");
}
const sum = (widths: readonly number[]) => widths.reduce((total, width) => total + width, 0);

/**
 * Between two blocks: a line break where they join (inside a tight list), else a blank
 * line. The blank line stays in the quotes both blocks are in (`> a`, `>`, `> b`), one
 * fewer when the second starts a quote of its own.
 */
function separator(doc: Doc, index: number) {
  const previous = doc[index - 1];
  const block = doc[index];
  if (!previous || !block) return "";
  if (joins(doc, index)) return "\n";
  const shared = Math.min(quoteOf(previous), quoteOf(block)) - (block.break ? 1 : 0);
  return `\n${Array.from({ length: Math.max(0, shared) }, () => ">").join(" ")}\n`;
}

/** A block's own Markdown, without the prefixes its place adds. */
function bodyOf(block: Block): string {
  if (block.source !== undefined) return block.source;
  switch (block.type) {
    case "paragraph":
    case "item":
      return serializeInline(block.content);
    case "heading": {
      const text = serializeInline(block.content, { heading: true });
      return `${"#".repeat(block.level)} ${text}`.trimEnd();
    }
    case "code": {
      // An info string holding a backtick cannot follow a backtick fence.
      const fence = fenceFor(block.text, block.lang.includes("`") ? "~" : "`", FENCE);
      return `${fence}${block.lang}\n${block.text}\n${fence}`;
    }
    case "raw":
      return block.text;
    case "rule":
      return "---";
  }
}

/** An item's marker: its bullet, or its number and delimiter, and the space after. */
function bulletOf(doc: Doc, index: number, block: Extract<Block, { type: "item" }>) {
  if (block.list === "ordered")
    return `${listNumber(doc, index)}${block.marker === ")" ? ")" : "."} `;
  return `${block.marker === "*" || block.marker === "+" ? block.marker : "-"} `;
}

/**
 * `text` with `first` before its first line and `rest` before the others. A line left
 * empty keeps no trailing space (`>`, not `> `); `exact` text (code) keeps its own.
 */
function prefix(text: string, first: string, rest: string, options: { exact: boolean }) {
  return text
    .split("\n")
    .map((line, i) => {
      const lead = i === 0 ? first : rest;
      if (!line) return lead.replace(/ +$/, "");
      return options.exact ? lead + line : (lead + line).replace(/ +$/, "");
    })
    .join("\n");
}

/** `#`s ending a heading's text would read as its closing sequence. */
const escapeClosingHashes = (text: string) => text.replace(/(^|\s)(#+)$/, "$1\\$2");

/** A fence of `char` longer than any run of it inside `text`, at least `min` long. */
function fenceFor(text: string, char: string, min: number) {
  const runs = text.match(new RegExp(`${escapeRegExp(char)}+`, "g")) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return char.repeat(Math.max(min, longest + 1));
}
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Delimiter = "link" | "bold" | "italic" | "strike";
type Emphasis = Exclude<Delimiter, "link">;
const ORDER: readonly Delimiter[] = ["link", "bold", "italic", "strike"];
const STRIKE_OUTSIDE: readonly Delimiter[] = ["link", "strike", "bold", "italic"];

/** How emphasis is spelled: its opening and closing delimiters per mark. */
type Spelling = Readonly<Record<Emphasis, readonly [string, string]>>;
const STARS: Spelling = { bold: ["**", "**"], italic: ["*", "*"], strike: ["~~", "~~"] };
const UNDERSCORES: Spelling = { bold: ["__", "__"], italic: ["_", "_"], strike: ["~~", "~~"] };
const MIXED: Spelling = { bold: ["**", "**"], italic: ["_", "_"], strike: ["~~", "~~"] };
const MIXED_BOLD: Spelling = { bold: ["__", "__"], italic: ["*", "*"], strike: ["~~", "~~"] };
const TAGS: Spelling = {
  bold: ["<strong>", "</strong>"],
  italic: ["<em>", "</em>"],
  strike: ["<del>", "</del>"],
};
/**
 * The ways tried, in order, until one reads back as written: marked (the reader) departs
 * from CommonMark on some runs of mixed delimiters (`~~*`, `***` closing a `*` and a `**`
 * opened apart). Nested stars first; then other spellings and nestings; then each run
 * delimited on its own, stars and underscores alternating; last, HTML tags, which every
 * reader keeps.
 */
type Strategy = {
  readonly spelling: (run: number) => Spelling;
  readonly flat: boolean;
  readonly order: readonly Delimiter[];
};
const nested = (spelling: Spelling, order: readonly Delimiter[]): Strategy => ({
  spelling: () => spelling,
  flat: false,
  order,
});
const STRATEGIES: readonly Strategy[] = [
  ...[STARS, MIXED, MIXED_BOLD, UNDERSCORES].flatMap((spelling) => [
    nested(spelling, ORDER),
    nested(spelling, STRIKE_OUTSIDE),
  ]),
  { spelling: (run) => (run % 2 ? UNDERSCORES : STARS), flat: true, order: ORDER },
  { spelling: () => TAGS, flat: true, order: ORDER },
];

/**
 * Runs of marked text to Markdown that reads back as the same runs. Text is first written
 * as it is, punctuation unescaped, and kept so when it reads back the same: `[^1]`, `> [!NOTE]`,
 * `$a_1$` or `[[a page]]` stay what other tools read them as. Otherwise every character
 * Markdown could take is escaped.
 */
export function serializeInline(inline: Inline, options: { heading?: boolean } = {}): string {
  const [first] = STRATEGIES;
  if (first) {
    const light = writeInline(inline, { ...options, ...first, light: true });
    if (readsBack(light, inline, options, { always: true })) return light;
  }
  let written = "";
  for (const strategy of STRATEGIES) {
    written = writeInline(inline, { ...options, ...strategy });
    if (readsBack(written, inline, options)) return written;
  }
  return written;
}

/**
 * Whether `markdown`, read as a paragraph (or a heading's text), gives back `inline`.
 * Escaped text reads back as itself: unless `always`, only formatting is checked.
 */
function readsBack(
  markdown: string,
  inline: Inline,
  options: { heading?: boolean },
  check: { always?: boolean } = {},
) {
  if (
    !check.always &&
    !inline.some(
      (span) =>
        span.marks.bold || span.marks.italic || span.marks.strike || span.marks.link !== undefined,
    )
  )
    return true;
  const blocks = parseMarkdown(options.heading ? `# ${markdown}` : markdown);
  const [block] = blocks;
  if (blocks.length !== 1 || block?.type !== (options.heading ? "heading" : "paragraph"))
    return false;
  const content = isText(block) ? block.content : [];
  return drawnKey(content, options) === drawnKey(inline, options);
}

const wants = (marks: Marks, delimiter: Delimiter, href: string | undefined) =>
  delimiter === "link"
    ? marks.link !== undefined && marks.link === href
    : marks[delimiter] === true;

/**
 * Runs of marked text to Markdown, delimiters properly nested. A mark that runs further
 * wraps the ones that end sooner (`***a* b**`, not `***a** b*` closed and reopened), so no
 * two closings cross; spaces at the edge of a run move outside its delimiters (`** x**` is
 * not emphasis in CommonMark, ` **x**` is). `flat` closes every delimiter at each run's end.
 */
function writeInline(
  inline: Inline,
  options: { heading?: boolean; light?: boolean } & Strategy,
): string {
  const spans = inline
    .map((span) => ({
      text: options.heading ? span.text.replaceAll("\n", " ") : span.text,
      marks: span.marks,
    }))
    // A link that is its own address is written as one: `<https://x.y>`.
    .map((span) => (isAutolink(span) ? { text: `<${span.text}>`, marks: VERBATIM } : span))
    // Spaces alone carry no visible mark: they join whatever surrounds them. Code and
    // text kept as written are exact, spaces included.
    .map((span) =>
      span.text.trim() || span.marks.code || span.marks.verbatim
        ? span
        : { text: span.text, marks: null, link: span.marks.link },
    );
  const open: { delimiter: Delimiter; href?: string; title?: string; close: string }[] = [];
  let out = "";
  let pendingSpace = "";
  const close = (keep: number) => {
    while (open.length > keep) {
      const last = open.pop();
      if (!last) break;
      out +=
        last.delimiter === "link"
          ? `](${destination(last.href ?? "")}${last.title === undefined ? "" : ` ${linkTitle(last.title)}`})`
          : last.close;
    }
  };
  spans.forEach((span, index) => {
    const { marks } = span;
    if (!marks) {
      // Spaces outside a link end it: a link's underline shows where it stops.
      const link = open.findIndex((each) => each.delimiter === "link");
      if (link >= 0 && open[link]?.href !== ("link" in span ? span.link : undefined)) {
        out += pendingSpace;
        pendingSpace = "";
        close(link);
      }
      pendingSpace += span.text;
      return;
    }
    const exact = marks.code === true || marks.verbatim === true;
    const core = exact ? span.text : span.text.trim();
    const leading = exact
      ? ""
      : span.text.slice(0, span.text.length - span.text.trimStart().length);
    const trailing = exact ? "" : span.text.slice(span.text.trimEnd().length);
    // The marks wanted here, the longest-running outermost.
    const wanted = options.order
      .filter((delimiter) => wants(marks, delimiter, marks.link))
      .map((delimiter) => ({ delimiter, reach: reach(spans, index, delimiter, marks.link) }))
      .sort(
        (a, b) =>
          b.reach - a.reach ||
          stackIndex(open, a.delimiter, options.order) -
            stackIndex(open, b.delimiter, options.order),
      );
    let keep = 0;
    // Kept: the open delimiters that are still wanted, a link only to the same target.
    while (
      !options.flat &&
      keep < open.length &&
      keep < wanted.length &&
      open[keep]?.delimiter === wanted[keep]?.delimiter &&
      (open[keep]?.delimiter !== "link" ||
        (open[keep]?.href === marks.link && open[keep]?.title === marks.title))
    )
      keep++;
    close(keep);
    out += pendingSpace + leading;
    pendingSpace = "";
    for (const { delimiter } of wanted.slice(keep)) {
      // A `!` right before a link's `[` would make it an image.
      if (delimiter === "link" && /(^|[^\\])!$/.test(out)) out = `${out.slice(0, -1)}\\!`;
      const spelled =
        delimiter === "link" ? (["[", ""] as const) : options.spelling(index)[delimiter];
      out += spelled[0];
      open.push(
        delimiter === "link"
          ? {
              delimiter,
              href: marks.link,
              ...(marks.title === undefined ? {} : { title: marks.title }),
              close: "",
            }
          : { delimiter, close: spelled[1] },
      );
    }
    if (marks.verbatim) out += core;
    else if (marks.escaped) out += core.replace(ASCII_PUNCTUATION, "\\$&");
    else if (marks.code) out += codeSpan(core.replaceAll("\n", " "));
    else
      out += escapeText(core, {
        lineStart: out === "" || out.endsWith("\n"),
        inLink: marks.link !== undefined,
        light: options.light === true,
      });
    pendingSpace = trailing;
  });
  close(0);
  // Spaces at the start of a line would indent it (four make code), at its end break it.
  const trimmed = out.replace(/^[ \t]+|[ \t]+$/gm, "");
  return options.heading ? escapeClosingHashes(trimmed) : trimmed;
}

const VERBATIM: Marks = { verbatim: true };
const AUTOLINKABLE = /^(?:https?|ftp):\/\/[^\s<>]+$/i;
/** A span that is only a link to its own text, an address: an autolink. */
const isAutolink = (span: { text: string; marks: Marks }) =>
  span.marks.link === span.text &&
  AUTOLINKABLE.test(span.text) &&
  Object.keys(span.marks).every((mark) => mark === "link");

/** A link's destination: bare when it can be, else between `<` and `>`. */
function destination(href: string) {
  if (href && !/[\s<>()\\]/.test(href)) return href;
  return `<${href.replace(/[\\<>]/g, "\\$&")}>`;
}
const linkTitle = (title: string) => `"${title.replace(/["\\]/g, "\\$&")}"`;

/** How many runs from `index` on keep `delimiter` (spaces alone do not interrupt it). */
function reach(
  spans: readonly { marks: Marks | null }[],
  index: number,
  delimiter: Delimiter,
  href: string | undefined,
) {
  let count = 0;
  for (let i = index; i < spans.length; i++) {
    const marks = spans[i]?.marks;
    if (marks === null) continue;
    if (!marks || !wants(marks, delimiter, href)) break;
    count++;
  }
  return count;
}
/** Where `delimiter` is in the open stack; not open sorts last. */
const stackIndex = (
  open: readonly { delimiter: Delimiter }[],
  delimiter: Delimiter,
  order: readonly Delimiter[],
) => {
  const at = open.findIndex((each) => each.delimiter === delimiter);
  return at < 0 ? open.length + order.indexOf(delimiter) : at;
};

/**
 * A code span: a fence longer than any backtick run inside, and one space of padding
 * where CommonMark would otherwise take it from the text (a text that starts and ends with
 * a space loses one of each) or read a backtick as part of the fence.
 */
function codeSpan(text: string) {
  const fence = fenceFor(text, "`", 1);
  const spaced = text.startsWith(" ") && text.endsWith(" ") && text.trim() !== "";
  const pad = text.startsWith("`") || text.endsWith("`") || spaced ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** What a backslash can escape in CommonMark. */
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/g;
/** Characters that would start Markdown where the text means them literally. */
const INLINE_SPECIAL = /[\\*_`[\]~<]/g;
/** What is escaped even when the text reads back as itself: a backslash, and HTML's `<`. */
const LIGHT_SPECIAL = /\\(?=[!-/:-@[-`{-~])|</g;
// What GFM would turn into a link on its own: an address, a scheme, `www.`.
const AUTOLINK_EMAIL = /([\w.+-])@(?=[\w-]+\.)/g;
const AUTOLINK_SCHEME = /\b(https?|mailto|xmpp|ftp):/gi;
const AUTOLINK_WWW = /\bwww\./gi;
const LINE_START_SPECIAL = /^(#{1,6}(?=\s|$)|[-+](?=\s|$)|>|=+\s*$|-+\s*$)/;
const ORDERED_START = /^(\d+)([.)])(?=\s|$)/;

/**
 * Plain text made to read as itself. In a link's text nothing turns into a link (GFM does
 * not link inside a link), so addresses and URLs stay as they are there.
 */
function escapeText(
  text: string,
  options: { lineStart: boolean; inLink: boolean; light: boolean },
) {
  return text
    .split("\n")
    .map((line, i) => {
      let escaped = line
        .replace(options.light ? LIGHT_SPECIAL : INLINE_SPECIAL, "\\$&")
        .replace(REFERENCE_START, "\\&");
      if (!options.inLink && !options.light)
        escaped = escaped
          .replace(AUTOLINK_EMAIL, "$1\\@")
          .replace(AUTOLINK_SCHEME, "$1\\:")
          .replace(AUTOLINK_WWW, "www\\.");
      // A line of pipes and dashes would read as a table's delimiter row.
      if (/^[\s|:\\-]*\|[\s|:\\-]*$/.test(escaped)) escaped = escaped.replace(/(?<!\\)\|/g, "\\|");
      if (i > 0 || options.lineStart) {
        // The line's indentation is dropped when written: its start is what follows.
        escaped = escaped.replace(/^[ \t]+/, "").replace(LINE_START_SPECIAL, "\\$&");
        escaped = escaped.replace(ORDERED_START, "$1\\$2");
      }
      return escaped;
    })
    .join("\n");
}
