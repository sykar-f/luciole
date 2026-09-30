import { Lexer, type MarkedToken, type Token, type Tokens } from "marked";
import { EMPTY_DOC, headingLevel } from "../model/doc.ts";
import { cleanMarks, normalize } from "../model/inline.ts";
import { splitReferences } from "../model/entities.ts";
import type { Block, Doc, Inline, ListMarker, Marks, Span } from "../model/types.ts";

// Markdown to a document, through marked's GFM lexer. What the editor models becomes
// blocks and marks; anything else (tables, HTML, a list holding code) becomes a raw block
// kept character for character: reading a note never loses a part of it.

export function parseMarkdown(markdown: string): Doc {
  const blocks = blocksOfAll(new Lexer({ gfm: true }).lex(markdown), TOP);
  return blocks.length ? blocks : EMPTY_DOC;
}

/** Where the tokens being read sit: in how many quotes, inside how many list levels. */
type Context = { readonly quote: number; readonly depth: number };
const TOP: Context = { quote: 0, depth: 0 };

/** `block` placed in `context`. */
const place = <T extends Block>(block: T, context: Context): T => ({
  ...block,
  ...(context.quote ? { quote: context.quote } : {}),
  ...(context.depth && block.type !== "item" ? { depth: context.depth } : {}),
});

function blocksOfAll(tokens: readonly Token[], context: Context): Block[] {
  const blocks: Block[] = [];
  for (const token of tokens) {
    const read = blocksOf(token, context);
    const first = read[0];
    // Two quotes a blank line apart are two quotes, not one of two paragraphs.
    const previous = blocks.at(-1);
    if (first && token.type === "blockquote" && previous && (previous.quote ?? 0) > context.quote)
      read[0] = { ...first, break: true };
    blocks.push(...read);
  }
  return blocks;
}

const sourceOf = (token: Token) => token.raw.replace(/\s+$/, "");
const raw = (token: Token, context: Context): Block[] => [
  place({ type: "raw", text: sourceOf(token) }, context),
];

function blocksOf(token: Token, context: Context): Block[] {
  if (!known(token)) return raw(token, context);
  switch (token.type) {
    case "space":
      return [];
    case "heading":
      return [
        place(
          {
            type: "heading",
            level: headingLevel(token.depth),
            content: inlineOf(token.tokens).map(flattenBreak),
            source: sourceOf(token),
          },
          context,
        ),
      ];
    case "paragraph":
      return [
        place(
          { type: "paragraph", content: inlineOf(token.tokens), source: sourceOf(token) },
          context,
        ),
      ];
    case "code":
      return [
        place(
          { type: "code", lang: token.lang ?? "", text: token.text, source: sourceOf(token) },
          context,
        ),
      ];
    case "hr":
      return [place({ type: "rule", source: sourceOf(token) }, context)];
    case "blockquote": {
      // A quote inside a list item cannot be placed (quotes hold lists): kept as written.
      if (context.depth > 0) return raw(token, context);
      const inner = { quote: context.quote + 1, depth: 0 };
      const blocks = blocksOfAll(token.tokens, inner);
      // An empty quote (`>` alone) is one empty paragraph of quote.
      return blocks.length ? blocks : [place({ type: "paragraph", content: [] }, inner)];
    }
    case "list":
      return listOf(token, context) ?? raw(token, context);
    default:
      return raw(token, context);
  }
}

/**
 * A list's items as blocks: nested lists one level deeper, and what else an item holds
 * (paragraphs, code, headings) placed inside it. Null if an item holds what cannot be
 * placed there (a quote).
 */
function listOf(list: Tokens.List, context: Context): Block[] | null {
  const indent = context.depth;
  const blocks: Block[] = [];
  const start = typeof list.start === "number" && list.start !== 1 ? list.start : undefined;
  const marker = markerOf(list.items[0]?.raw ?? "", list.ordered);
  const inside: Context = { quote: context.quote, depth: indent + 1 };
  for (const [index, item] of list.items.entries()) {
    let content: Inline | null = null;
    const rest: Block[] = [];
    for (const child of item.tokens) {
      if (child.type === "checkbox" || child.type === "space") continue;
      if (!known(child)) return null;
      // The item's own text: its first paragraph, unless something else comes first.
      if (
        (child.type === "text" || child.type === "paragraph") &&
        content === null &&
        !rest.length
      ) {
        content = child.tokens
          ? inlineOf(child.tokens)
          : normalize([{ text: child.text, marks: {} }]);
        continue;
      }
      if (child.type === "blockquote") return null;
      const placed =
        child.type === "text"
          ? [place({ type: "paragraph" as const, content: inlineOf(child.tokens ?? []) }, inside)]
          : blocksOf(child, inside);
      rest.push(...placed);
    }
    blocks.push(
      place(
        {
          type: "item",
          list: item.task ? "task" : list.ordered ? "ordered" : "bullet",
          indent,
          ...(item.task ? { checked: item.checked === true } : {}),
          ...(index === 0 && start !== undefined ? { start } : {}),
          ...(marker ? { marker } : {}),
          ...(list.loose ? { loose: true } : {}),
          content: content ?? [],
        },
        context,
      ),
    );
    blocks.push(...rest);
  }
  return blocks;
}

/** The character of a list's marker, from its first item as written. */
function markerOf(raw: string, ordered: boolean): ListMarker | undefined {
  const found = (ordered ? /^\s*\d+([.)])/ : /^\s*([-*+])/).exec(raw)?.[1];
  return found === "-" || found === "*" || found === "+" || found === "." || found === ")"
    ? found
    : undefined;
}

/** HTML tags that are emphasis: read as marks, as the serializer's last resort writes them. */
const TAG_MARKS: Readonly<Record<string, "bold" | "italic" | "strike">> = {
  strong: "bold",
  b: "bold",
  em: "italic",
  i: "italic",
  del: "strike",
  s: "strike",
};
const TAG = /^<(\/?)([a-z]+)>$/;

function inlineOf(tokens: readonly Token[], marks: Marks = {}): Inline {
  const paired = pairedTags(tokens);
  const spans: Span[] = [];
  // Emphasis opened by tags (`<em>`), innermost last.
  const tags: ("bold" | "italic" | "strike")[] = [];
  tokens.forEach((token, index) => {
    const tag = paired.get(index);
    if (tag?.closing) tags.splice(tags.lastIndexOf(tag.mark), 1);
    else if (tag) tags.push(tag.mark);
    else {
      const inside = tags.reduce<Marks>((all, each) => ({ ...all, [each]: true }), marks);
      spans.push(...spansOf(token, cleanMarks(inside)));
    }
  });
  return normalize(spans);
}

/** The emphasis tags among `tokens` that open and close in them: the others stay as written. */
function pairedTags(tokens: readonly Token[]) {
  const paired = new Map<number, { mark: "bold" | "italic" | "strike"; closing: boolean }>();
  const open: { name: string; index: number }[] = [];
  tokens.forEach((token, index) => {
    const tag = token.type === "html" ? TAG.exec(token.raw) : null;
    const name = tag?.[2] ?? "";
    const mark = TAG_MARKS[name];
    if (!tag || !mark) return;
    if (!tag[1]) {
      open.push({ name, index });
      return;
    }
    const at = open.findLastIndex((each) => each.name === name);
    const opening = open[at];
    if (!opening) return;
    open.splice(at);
    paired.set(opening.index, { mark, closing: false });
    paired.set(index, { mark, closing: true });
  });
  return paired;
}

function spansOf(token: Token, marks: Marks): Span[] {
  const verbatim = [{ text: token.raw, marks: cleanMarks({ ...marks, verbatim: true }) }];
  if (!known(token)) return verbatim;
  const nested = (children: readonly Token[] | undefined, added: Marks) => [
    ...inlineOf(children ?? [], cleanMarks({ ...marks, ...added })),
  ];
  switch (token.type) {
    case "text":
      return token.tokens?.length ? nested(token.tokens, {}) : textSpans(token.text, marks);
    case "escape":
      return [{ text: token.text, marks: cleanMarks({ ...marks, escaped: true }) }];
    case "strong":
      return nested(token.tokens, { bold: true });
    case "em":
      return nested(token.tokens, { italic: true });
    case "del":
      return nested(token.tokens, { strike: true });
    case "codespan":
      // An empty code span has no text to hold its mark: it stays as written.
      return token.text
        ? [{ text: token.text, marks: cleanMarks({ ...marks, code: true }) }]
        : verbatim;
    case "link": {
      const label = nested(token.tokens, {
        link: token.href,
        ...(token.title ? { title: token.title } : {}),
      });
      return label.length ? label : verbatim;
    }
    case "br":
      return [{ text: "\n", marks }];
    case "checkbox":
      return [];
    default:
      // An image, inline HTML, an autolink written <like this>: kept as written.
      return verbatim;
  }
}

/** Plain text, its character references decoded; an unknown one stays as written. */
const textSpans = (text: string, marks: Marks): Span[] =>
  splitReferences(text).map((part) => ({
    text: part.text,
    marks: part.known ? marks : cleanMarks({ ...marks, verbatim: true }),
  }));

/** A heading is one line: a break inside one reads as a space. */
const flattenBreak = (span: Span): Span =>
  span.text.includes("\n") ? { text: span.text.replaceAll("\n", " "), marks: span.marks } : span;

const KINDS: ReadonlySet<string> = new Set<MarkedToken["type"]>([
  "blockquote",
  "br",
  "checkbox",
  "code",
  "codespan",
  "def",
  "del",
  "em",
  "escape",
  "heading",
  "hr",
  "html",
  "image",
  "link",
  "list",
  "list_item",
  "paragraph",
  "space",
  "strong",
  "table",
  "text",
]);
/** Narrows marked's open `Token` union (it admits any `type`) to the tokens it documents. */
const known = (token: Token): token is MarkedToken => KINDS.has(token.type);
