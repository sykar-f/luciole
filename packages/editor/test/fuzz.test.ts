/**
 * Random documents written to Markdown and read back: every one comes back as it was.
 * Seeded, so a failure replays; the seed and the Markdown are in its message.
 */
import { expect, test } from "bun:test";
import { parseMarkdown } from "../src/markdown/parse.ts";
import { serializeMarkdown } from "../src/markdown/serialize.ts";
import { normalize } from "../src/model/inline.ts";
import type { Block, Doc, Inline, Marks } from "../src/model/types.ts";
import { meaning } from "./spec-harness.ts";

/** A small, fast, seeded generator (mulberry32). */
function random(seed: number) {
  let state = seed;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(items: readonly T[]): T => {
    const item = items[int(items.length)];
    if (item === undefined) throw new Error("Nothing to pick from");
    return item;
  };
  return { next, int, pick, chance: (p: number) => next() < p };
}
type Random = ReturnType<typeof random>;

// Words, and characters Markdown gives a meaning to.
const WORDS = [
  "©",
  "&",
  "&lt;",
  "&#35;",
  "10 < 20",
  "note",
  "déjà",
  "x",
  "2026",
  "café",
  "a_b",
  "*",
  "_",
  "`",
  "~",
  "#",
  "-",
  "+",
  "1.",
  ">",
  "[",
  "]",
  "(",
  ")",
  "!",
  "<",
  "&",
  "&amp;",
  "\\",
  "|",
  "www.x.y",
  "me@x.y",
  "http://x.y",
  "<b>",
];

function inline(r: Random): Inline {
  const spans: { text: string; marks: Marks }[] = [];
  const count = 1 + r.int(4);
  for (let i = 0; i < count; i++) {
    const words = Array.from({ length: 1 + r.int(3) }, () => r.pick(WORDS)).join(" ");
    const code = r.chance(0.12);
    const marks: Marks = code
      ? { code: true }
      : {
          ...(r.chance(0.3) ? { bold: true } : {}),
          ...(r.chance(0.3) ? { italic: true } : {}),
          ...(r.chance(0.15) ? { strike: true } : {}),
          ...(r.chance(0.15) ? { link: r.pick(["https://x.y", "/a b", "u(1)"]) } : {}),
        };
    spans.push({ text: i === 0 ? words : ` ${words}`, marks });
  }
  return normalize(spans);
}

function doc(r: Random): Doc {
  const blocks: Block[] = [];
  const count = 1 + r.int(6);
  let indent = -1;
  let lastQuote = 0;
  for (let i = 0; i < count; i++) {
    const quote = r.chance(0.25) ? 1 + r.int(2) : 0;
    const place = quote ? { quote } : {};
    // A list goes on only in the same quotes.
    if (quote !== lastQuote) indent = -1;
    lastQuote = quote;
    const kind = r.int(6);
    if (kind === 0) {
      blocks.push({
        type: "heading",
        level: r.pick([1, 2, 3, 4, 5, 6] as const),
        content: inline(r),
        ...place,
      });
      indent = -1;
    } else if (kind === 1) {
      // Items nest one level at most below the previous item.
      indent = Math.max(0, Math.min(indent + 1, r.int(3)));
      const list = r.pick(["bullet", "ordered", "task"] as const);
      blocks.push({
        type: "item",
        list,
        indent,
        ...(list === "task" ? { checked: r.chance(0.5) } : {}),
        content: inline(r),
        ...place,
      });
    } else if (kind === 2) {
      blocks.push({
        type: "code",
        lang: r.pick(["", "ts", "sh"]),
        text: r.pick(["a", "if (x) {\n  y();\n}", "``` inside"]),
        ...place,
      });
      indent = -1;
    } else if (kind === 3 && indent >= 0 && r.chance(0.6)) {
      // Something an item holds, under its text; deeper items are closed below it.
      const depth = 1 + r.int(indent + 1);
      const inside = { ...place, depth };
      indent = depth - 1;
      blocks.push(
        r.chance(0.5)
          ? { type: "paragraph", content: inline(r), ...inside }
          : { type: "code", lang: "", text: "held", ...inside },
      );
    } else if (kind === 3 && r.chance(0.3)) {
      blocks.push({ type: "raw", text: "<div>\nhtml\n</div>", ...place });
      indent = -1;
    } else if (kind === 3 && blocks.length) {
      blocks.push({ type: "rule", ...place });
      indent = -1;
    } else {
      blocks.push({ type: "paragraph", content: inline(r), ...place });
      indent = -1;
    }
  }
  return blocks;
}

/**
 * A block's text as it is drawn: each character with its marks, spaces without any (a
 * space at the edge of bold text is written outside its `**`), escapes as plain text.
 */
function drawn(content: Inline) {
  const chars = content.flatMap((span) =>
    Array.from(span.text, (char) => {
      const { escaped: _, ...marks } = span.marks;
      return { text: char, marks: /\s/.test(char) && !marks.code ? {} : marks };
    }),
  );
  return normalize(chars).map((span) => [span.text, span.marks]);
}

/** What must come back: kinds, places, texts and marks (not how the Markdown was spelled). */
function shape(document: Doc) {
  return document.map((block) => ({
    type: block.type,
    quote: block.quote ?? 0,
    ...(block.type === "heading" ? { level: block.level } : {}),
    ...(block.type === "item"
      ? { list: block.list, indent: block.indent, checked: block.checked }
      : {}),
    ...(block.type === "code" ? { lang: block.lang, text: block.text } : {}),
    ...(block.type === "raw" ? { text: block.text } : {}),
    ...(block.type !== "item" && block.depth ? { depth: block.depth } : {}),
    ...("content" in block ? { content: drawn(block.content) } : {}),
  }));
}

test("5000 random documents come back from their Markdown as they were", () => {
  const failures: string[] = [];
  for (let seed = 1; seed <= 5000 && failures.length < 5; seed++) {
    const written = doc(random(seed));
    const markdown = serializeMarkdown(written);
    const read = parseMarkdown(markdown);
    const expected = JSON.stringify(shape(written));
    if (JSON.stringify(shape(read)) !== expected)
      failures.push(
        `seed ${seed}:\n${markdown}\n--- expected\n${expected}\n--- read\n${JSON.stringify(shape(read))}`,
      );
  }
  expect(failures).toEqual([]);
});

test("the comparison tells apart what is drawn apart", () => {
  const differ = [
    ["*a*", "a"],
    ["**a**", "*a*"],
    ["[a](x)", "[a](y)"],
    ["# a", "a"],
    ["# a", "## a"],
    ["- a", "1. a"],
    ["- a\n- b", "- a\n\n  b"],
    ["> a", "a"],
    ["`a`", "a"],
    ["~~a~~", "a"],
    ["a b", "a  b\n\nc"],
    ["```\na  b\n```", "```\na b\n```"],
  ];
  for (const [a = "", b = ""] of differ)
    expect({ a, b, same: meaning(a) === meaning(b) }).toEqual({ a, b, same: false });
  const alike = [
    ["*a*", "_a_"],
    ["a\nb", "a  \nb"],
    ["&copy;", "©"],
    ["**a**", "__a__"],
  ];
  for (const [a = "", b = ""] of alike)
    expect({ a, b, same: meaning(a) === meaning(b) }).toEqual({ a, b, same: true });
});
