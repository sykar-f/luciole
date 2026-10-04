/**
 * The prose lint of the public corpus: the measurable rules of website/STYLE.md, checked on
 * the /docs pages, the READMEs of the repository, its packages and examples, and the text of
 * the site's Astro pages and components.
 *   bun website/scripts/prose-lint.ts [paths]   # files or directories, the corpus by default
 *
 * In Markdown, front matter (but its `description`), imports, fenced code, HTML blocks and
 * JSX tags are set aside; the Markdown inside a component (a Note's text) is prose, and so is
 * each table cell. In an Astro file, the text of the markup is prose, each block element a
 * paragraph; so are the string literals of its code that read as prose, and the values of
 * the attributes a reader sees (`alt`, `title`…). A `.ts` file gives its prose literals.
 *
 * It prints one `path:line rule` per finding, then applies the ratchet of
 * prose-allowlist.json to the files it read: a file that is not listed must have no
 * finding, and a listed file must have exactly its count, so that a file that improves
 * locks its gain. The exit code is 1 when the ratchet fails.
 *
 * A finding can be silenced, with its reason, by a comment on the line before it:
 *   {/* prose-lint: allow long-sentence — a command's flags read as one unit *\/}
 * (`<!-- … -->` in a .md file or Astro markup, `// …` in code). An exception that silences
 * nothing is a finding itself.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { z } from "zod";

export const root = resolve(import.meta.dirname, "../..");
export const allowlistPath = resolve(import.meta.dirname, "prose-allowlist.json");
export const stylePath = resolve(import.meta.dirname, "../STYLE.md");
const docs = join(root, "website/src/content/docs");
const site = join(root, "website/src");

const MAX_PARAGRAPH_WORDS = 60;
const MAX_SENTENCE_WORDS = 30;

export const rules = [
  "long-paragraph",
  "long-sentence",
  "chained-clauses",
  "split-paragraph",
  "avoid-term",
  "bad-allow",
  "unused-allow",
] as const;
export type Rule = (typeof rules)[number];

export interface Finding {
  path: string;
  line: number;
  rule: Rule;
  detail: string;
}

const isRule = (name: string): name is Rule => rules.some((rule) => rule === name);

/** A run of prose lines that renders as one paragraph, one list item or one table cell. */
interface Block {
  lines: { line: number; text: string }[];
  /** A table cell, or text out of an Astro file: no paragraph of Markdown goes on in it. */
  cell?: true;
}

interface Comment {
  line: number;
  text: string;
}

/** What a file gives the rules: its prose, its headings, and its exception comments. */
interface Prose {
  blocks: Block[];
  /** Checked for terms only: a heading has no length to keep. */
  headings: Block[];
  comments: Comment[];
}

/** How far ahead of a token's first character the scanner reads to match it whole. */
const TOKEN_WINDOW = 64;
/** Length of `-->`, the end of an HTML comment. */
const COMMENT_END_LENGTH = 3;
/** Length of `---`, the fence of a front matter block. */
const FRONT_MATTER_FENCE_LENGTH = 3;

const FENCE = /^(`{3,}|~{3,})/;
const LIST_ITEM = /^([-*+]|\d+[.)])\s+/;
/** Tags that sit inside a sentence: a line that starts with one is prose. */
const INLINE_TAG = /^<\/?(kbd|code|Src|a|em|strong|b|i|br|sup|sub|abbr|span)\b/;
const COMMENT_ONLY = /^(\{\/\*.*\*\/\}|<!--.*-->)$/;
const ALLOW = /prose-lint:\s*allow\s+([\w-]+)\s*(?:—|--?)\s*(\S.*?)\s*(?:\*\/\}?|-->|$)/;
const TABLE_RULE = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;

/** The cells of a table row, split on the pipes that are neither escaped nor in code. */
function cells(row: string) {
  const found: string[] = [];
  let cell = "";
  let code = false;
  for (let at = 0; at < row.length; at++) {
    const char = row[at];
    if (char === "\\" && row[at + 1] === "|") {
      cell += "|";
      at++;
    } else if (char === "`") {
      code = !code;
      cell += char;
    } else if (char === "|" && !code) {
      found.push(cell);
      cell = "";
    } else cell += char;
  }
  found.push(cell);
  if (row.trimStart().startsWith("|")) found.shift();
  if (row.trimEnd().endsWith("|")) found.pop();
  return found.map((text) => text.trim()).filter((text) => text !== "");
}

/** The `description` of a front matter, on one line, without its YAML quotes. */
function description(line: string) {
  const value = /^description:\s*(.+)$/.exec(line)?.[1]?.trim();
  if (!value) return undefined;
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  return value;
}

/**
 * Splits a Markdown page into prose blocks, and records the exception comments by line.
 * Lines are 1-based, as an editor shows them.
 */
function markdown(source: string): Prose {
  const lines = source.split("\n");
  const found: Block[] = [];
  const headings: Block[] = [];
  const comments: Comment[] = [];
  let current: Block | undefined;
  let fence: string | undefined;
  let skipUntil: RegExp | undefined;
  let htmlBlock = false;
  const close = () => {
    if (current) found.push(current);
    current = undefined;
  };

  let at = 0;
  if (lines[0]?.trim() === "---") {
    at = lines.findIndex((line, index) => index > 0 && line.trim() === "---") + 1;
    for (let index = 1; index < at - 1; index++) {
      const text = description(lines[index] ?? "");
      if (text) found.push({ lines: [{ line: index + 1, text }], cell: true });
    }
  }
  for (; at < lines.length; at++) {
    const raw = lines[at] ?? "";
    const text = raw.trim();
    const line = at + 1;

    if (fence) {
      if (text.startsWith(fence)) fence = undefined;
      continue;
    }
    if (skipUntil) {
      if (skipUntil.test(text)) skipUntil = undefined;
      continue;
    }
    if (htmlBlock) {
      if (text === "") htmlBlock = false;
      continue;
    }
    if (text.includes("prose-lint:")) comments.push({ line, text });
    if (COMMENT_ONLY.test(text)) continue;
    if (text === "") {
      close();
      continue;
    }
    const opening = FENCE.exec(text);
    if (opening) {
      close();
      fence = opening[1];
      continue;
    }
    if (/^(import|export)\s/.test(raw)) {
      close();
      if (!/;\s*$/.test(text)) skipUntil = /;\s*$/;
      continue;
    }
    if (text.startsWith("#")) {
      close();
      headings.push({ lines: [{ line, text: text.replace(/^#+\s*/, "") }] });
      continue;
    }
    if (text.startsWith("|")) {
      close();
      // Each cell is a paragraph of its own; the row under the header is not text.
      if (!TABLE_RULE.test(text))
        for (const cell of cells(text)) found.push({ lines: [{ line, text: cell }], cell: true });
      continue;
    }
    if (text.startsWith("<") && !INLINE_TAG.test(text)) {
      close();
      // A component's tag, maybe over several lines: its children are Markdown, checked.
      if (/^<\/?[A-Z]/.test(text)) {
        if (!/>\s*$/.test(text)) skipUntil = />\s*$/;
      } else htmlBlock = true;
      continue;
    }
    if (text.startsWith(">")) {
      current ??= { lines: [] };
      current.lines.push({ line, text: text.replace(/^>\s?/, "") });
      continue;
    }
    if (LIST_ITEM.test(text)) {
      close();
      current = { lines: [{ line, text: text.replace(LIST_ITEM, "") }] };
      continue;
    }
    current ??= { lines: [] };
    current.lines.push({ line, text });
  }
  close();
  return { blocks: found, headings, comments };
}

/** Elements that sit inside a sentence; any other element starts and ends a paragraph. */
const INLINE = new Set(
  "a abbr b bdi bdo cite data dfn em i kbd mark output q s samp small span strong sub sup time u var".split(
    " ",
  ),
);
const VOID = new Set("area base br col embed hr img input link meta source track wbr".split(" "));
/** Elements whose content is not prose: skipped up to their closing tag. */
const RAW = new Set(["script", "style", "pre", "textarea"]);
/** The attributes a reader sees or hears, and the page props that become them. */
const SPOKEN = new Set(["alt", "aria-label", "description", "label", "placeholder", "title"]);
const ENTITIES: Record<string, string> = {
  amp: "&",
  gt: ">",
  lt: "<",
  mdash: "—",
  nbsp: " ",
  ndash: "–",
  quot: '"',
};
const decode = (text: string) =>
  text.replace(/&(#x?[\da-f]+|\w+);/gi, (match, name: string) => {
    if (name.startsWith("#x")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(Number(name.slice(1)));
    return ENTITIES[name] ?? match;
  });

const COMMANDS = new Set(["bun", "bunx", "cd", "git", "node", "npm", "npx", "pnpm", "ssh", "yarn"]);
const PROSE_WORD = /^[("“'‘]*[\p{L}\p{N}][\p{L}\p{N}'’.,;:!?…)"”%-]*$/u;
const SEPARATOR = /^[·—–:]$/u;

/**
 * A string literal reads as prose when it has two words or more, made of letters and
 * sentence punctuation, one of them lowercase: not an identifier, a path, a key, a class list
 * or a command (`bun run dev`).
 */
function readsAsProse(value: string) {
  const words = value
    .replace(/\{[^{}]*\}/g, "X")
    .split(/\s+/)
    .filter((token) => token !== "" && !SEPARATOR.test(token));
  return (
    words.length >= 2 &&
    words.every((token) => PROSE_WORD.test(token)) &&
    words.some((token) => /^\p{Ll}{2,}[,.;:!?…]?$/u.test(token)) &&
    !COMMANDS.has(words[0] ?? "")
  );
}

interface Literal {
  offset: number;
  /** Its value, with the source's newlines, and `{x}` for each `${…}`. */
  value: string;
}

/** What an expression held: its literals, whether it had JSX, and anything else. */
interface Expression {
  literals: Literal[];
  jsx: boolean;
  other: boolean;
}

/**
 * The prose of an Astro file or a TypeScript module, read by a small scanner: the code
 * (front matter, expressions, a module) for its literals and comments, the markup for its
 * text, grouped in paragraphs by its block elements. A source it cannot read throws: a page
 * silently skipped would pass the lint.
 */
function sourceProse(source: string, kind: "astro" | "ts"): Prose {
  const starts = [0];
  for (let at = source.indexOf("\n"); at !== -1; at = source.indexOf("\n", at + 1))
    starts.push(at + 1);
  const lineOf = (offset: number) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((starts[middle] ?? 0) <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
  const fail = (offset: number, what: string): never => {
    throw new Error(`line ${lineOf(offset)}: ${what}`);
  };

  const blocks: Block[] = [];
  const headings: Block[] = [];
  const comments: Comment[] = [];
  let segments: { offset: number; text: string }[] = [];
  let heading = false;
  let at = 0;
  let end = source.length;

  /** The block made of these runs of text, each at its offset in the source. */
  const block = (runs: { offset: number; text: string }[]): Block | undefined => {
    const byLine = new Map<number, string>();
    for (const { offset, text } of runs) {
      const first = lineOf(offset);
      for (const [index, part] of text.split("\n").entries())
        byLine.set(first + index, (byLine.get(first + index) ?? "") + part);
    }
    const filled = [...byLine.entries()].filter(([, text]) => text.trim() !== "");
    if (filled.length === 0) return undefined;
    const first = Math.min(...filled.map(([line]) => line));
    const last = Math.max(...filled.map(([line]) => line));
    const lines = [];
    for (let line = first; line <= last; line++)
      lines.push({ line, text: (byLine.get(line) ?? "").trim() });
    return { lines, cell: true };
  };
  const flush = () => {
    const found = block(segments);
    if (found) (heading ? headings : blocks).push(found);
    segments = [];
  };
  const standalone = (literals: Literal[]) => {
    for (const { offset, value } of literals) {
      if (!readsAsProse(value)) continue;
      const found = block([{ offset, text: value }]);
      if (found) blocks.push(found);
    }
  };
  const comment = (offset: number, text: string) => {
    if (text.includes("prose-lint:")) comments.push({ line: lineOf(offset), text: text.trim() });
  };

  /** A string's value; an escape that is not a character of prose becomes a control one. */
  const quoted = (quote: string, interpolate: boolean): Literal => {
    const offset = ++at;
    let value = "";
    while (at < end) {
      const char = source[at] ?? "";
      if (char === "\\") {
        const next = source[at + 1] ?? "";
        value += /[nrtbfv0ux]/.test(next) ? "\u0001" : next;
        at += 2;
      } else if (char === quote) {
        at++;
        return { offset, value };
      } else if (interpolate && char === "$" && source[at + 1] === "{") {
        const start = at;
        at += 2;
        code(true, false);
        value += `{${source.slice(start, at).replace(/[^\n]/g, "")}x}`;
      } else {
        value += char;
        at++;
      }
    }
    return fail(offset, `unclosed ${quote}`);
  };

  const regex = () => {
    let inClass = false;
    for (at++; at < end; at++) {
      const char = source[at];
      if (char === "\\") at++;
      else if (char === "[") inClass = true;
      else if (char === "]") inClass = false;
      else if (char === "/" && !inClass) break;
      else if (char === "\n") fail(at, "unclosed regular expression");
    }
    at++;
    while (/[a-z]/.test(source[at] ?? "")) at++;
  };

  /**
   * Code up to its closing brace (`close`) or to the end. `jsx` reads the elements an
   * expression of the markup holds.
   */
  const code = (close: boolean, jsx: boolean): Expression => {
    const found: Expression = { literals: [], jsx: false, other: false };
    let depth = 0;
    let previous = "";
    while (at < end) {
      const char = source[at] ?? "";
      const next = source[at + 1] ?? "";
      if (char === "/" && next === "/") {
        const stop = source.indexOf("\n", at);
        const until = stop === -1 ? end : stop;
        comment(at, source.slice(at, until));
        at = until;
      } else if (char === "/" && next === "*") {
        const stop = source.indexOf("*/", at + 2);
        if (stop === -1) fail(at, "unclosed comment");
        comment(at, source.slice(at, stop + 2));
        at = stop + 2;
      } else if (/\s/.test(char)) {
        at++;
      } else if (char === '"' || char === "'" || char === "`") {
        found.literals.push(quoted(char, char === "`"));
        previous = '"';
      } else if (
        char === "/" &&
        (previous === "" || /^([(,=:[!&|?{};+*%<>~^-]|return|typeof)$/.test(previous))
      ) {
        regex();
        found.other = true;
        previous = '"';
      } else if (
        jsx &&
        char === "<" &&
        /[A-Za-z>]/.test(next) &&
        (previous === "" || /^([(,=:[!&|?{};>]|return)$/.test(previous))
      ) {
        element();
        found.jsx = true;
        previous = ")";
      } else if (/[\w$]/.test(char)) {
        const word = /^[\w$]+/.exec(source.slice(at, at + TOKEN_WINDOW))?.[0] ?? char;
        at += word.length;
        previous = word;
        found.other = true;
      } else {
        if (char === "{") depth++;
        if (char === "}") {
          if (depth === 0 && close) {
            at++;
            return found;
          }
          depth--;
        }
        at++;
        previous = char;
        found.other = true;
      }
    }
    if (close) fail(at, "unclosed {");
    return found;
  };

  /** An expression of the markup: its value is a word of the sentence it sits in. */
  const expression = () => {
    const start = at++;
    const found = code(true, true);
    const [only] = found.literals;
    if (!found.jsx && !found.other && only && found.literals.length === 1) {
      segments.push({ offset: only.offset, text: only.value });
      return;
    }
    standalone(found.literals);
    if (!found.jsx)
      segments.push({ offset: start, text: `{${source.slice(start, at).replace(/[^\n]/g, "")}x}` });
  };

  const element = () => {
    const start = at++;
    if (source[at] === ">") {
      at++;
      markup("");
      return;
    }
    const name =
      /^[\w:.-]+/.exec(source.slice(at, at + TOKEN_WINDOW))?.[0] ?? fail(at, "a tag without name");
    at += name.length;
    let closed = false;
    for (;;) {
      while (/\s/.test(source[at] ?? "")) at++;
      const char = source[at];
      if (char === undefined || at >= end) fail(start, `unclosed <${name}`);
      if (char === "/" && source[at + 1] === ">") {
        at += 2;
        closed = true;
        break;
      }
      if (char === ">") {
        at++;
        break;
      }
      if (char === "{") {
        at++;
        standalone(code(true, true).literals);
        continue;
      }
      const attribute =
        /^[^\s=/>]+/.exec(source.slice(at, at + TOKEN_WINDOW))?.[0] ?? fail(at, "a bad attribute");
      at += attribute.length;
      while (/\s/.test(source[at] ?? "")) at++;
      if (source[at] !== "=") continue;
      at++;
      while (/\s/.test(source[at] ?? "")) at++;
      const quote = source[at];
      if (quote === '"' || quote === "'") {
        const stop = source.indexOf(quote, at + 1);
        if (stop === -1) fail(at, `unclosed ${quote}`);
        const value = decode(source.slice(at + 1, stop));
        if (SPOKEN.has(attribute) && value.trim() !== "") {
          const found = block([{ offset: at + 1, text: value }]);
          if (found) blocks.push(found);
        }
        at = stop + 1;
      } else if (quote === "{") {
        at++;
        standalone(code(true, true).literals);
      } else if (quote === "`") {
        standalone([quoted("`", true)]);
      } else at += /^[^\s>]*/.exec(source.slice(at))?.[0].length ?? 0;
    }
    const tag = name.toLowerCase();
    const inline = INLINE.has(tag);
    if (closed || VOID.has(tag)) {
      if (tag === "br") segments.push({ offset: start, text: " " });
      else if (!inline && tag !== "img" && tag !== "wbr") flush();
      return;
    }
    if (RAW.has(tag) || tag === "code") {
      const stop = source.indexOf(`</${name}`, at);
      if (stop === -1) fail(start, `unclosed <${name}>`);
      at = source.indexOf(">", stop) + 1;
      // A code element is one word of its sentence, as a code span is in Markdown.
      if (tag === "code") segments.push({ offset: start, text: "`x`" });
      else flush();
      return;
    }
    if (inline) {
      markup(name);
      return;
    }
    flush();
    heading = /^h[1-6]$/.test(tag);
    markup(name);
    flush();
    heading = false;
  };

  /** Markup up to the closing tag of `close` ("" for a fragment), or to the end. */
  const markup = (close: string | undefined) => {
    while (at < end) {
      const char = source[at];
      const next = source[at + 1] ?? "";
      if (char === "<" && source.startsWith("<!--", at)) {
        const stop = source.indexOf("-->", at);
        if (stop === -1) fail(at, "unclosed comment");
        comment(at, source.slice(at, stop + COMMENT_END_LENGTH));
        at = stop + COMMENT_END_LENGTH;
        continue;
      }
      if (char === "<" && next === "/") {
        const tag = /^<\/([\w:.-]*)\s*>/.exec(source.slice(at, at + TOKEN_WINDOW));
        if (!tag) fail(at, "a bad closing tag");
        at += tag?.[0].length ?? 0;
        const name = tag?.[1] ?? "";
        if (name === close) return;
        if (close !== undefined) fail(at, `</${name}> closes <${close}>`);
        continue;
      }
      if (char === "<" && /[A-Za-z]/.test(next)) {
        element();
        continue;
      }
      if (char === "{") {
        expression();
        continue;
      }
      let stop = at + 1;
      while (stop < end && source[stop] !== "<" && source[stop] !== "{") stop++;
      segments.push({ offset: at, text: decode(source.slice(at, stop)) });
      at = stop;
    }
    if (close !== undefined) fail(at, `unclosed <${close}>`);
  };

  if (kind === "ts") standalone(code(false, false).literals);
  else {
    if (/^---\s*\n/.test(source)) {
      const stop = source.search(/\n---\s*(\n|$)/);
      if (stop === -1) fail(0, "unclosed front matter");
      at = FRONT_MATTER_FENCE_LENGTH;
      end = stop;
      standalone(code(false, false).literals);
      end = source.length;
      at = source.indexOf("\n", stop + 1) + 1 || end;
    }
    markup(undefined);
    flush();
  }
  return { blocks, headings, comments };
}

/** `length` characters that count as one word, carry no punctuation and can start a sentence. */
const word = (length: number) => `X${"x".repeat(length - 1)}`;
const blank = (length: number) => " ".repeat(length);

/**
 * The block's text with the same offsets, where code, expressions, URLs and tags no longer
 * count as punctuation or as several words: code is one word, a link is its text.
 */
function plain(text: string) {
  return text
    .replace(/\{\/\*[\s\S]*?\*\/\}|<!--[\s\S]*?-->/g, (match) => blank(match.length))
    .replace(/(`+)[\s\S]*?\1|<code\b[^>]*>[\s\S]*?<\/code>/g, (match) => word(match.length))
    .replace(/\{[^{}]*\}/g, (match) => word(match.length))
    .replace(/<[A-Z][^>]*\/>/g, (match) => word(match.length))
    .replace(/<\/?[a-zA-Z][^>]*>/g, (match) => blank(match.length))
    .replace(/\]\([^)]*\)|\]\[[^\]]*\]/g, (match) => blank(match.length))
    .replace(/\[/g, " ")
    .replace(/\b[a-z][\w+.-]*:\/\/\S+/g, (match) => word(match.length))
    .replace(/\b(e\.g|i\.e|cf|vs|etc)\./g, (match) => match.replaceAll(".", "_"));
}

const words = (text: string) => text.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token));

/** Sentence starts, as offsets into the block's text. */
function sentences(text: string) {
  const starts = [0];
  for (const match of text.matchAll(/[.!?…][)\]"'*_]*\s+(?=[^\s\p{Ll}])/gu))
    starts.push((match.index ?? 0) + match[0].length);
  return starts.map((start, index) => text.slice(start, starts[index + 1] ?? text.length));
}

/** Prose that ends a sentence, or a clause that announces what follows. */
const ENDS_SENTENCE = /[.!?:…][)\]"'*_`]*$/;
/** What starts the second half of a sentence cut by a blank line. */
const CONTINUES = /^(<(kbd|code|Src)\b|\p{Ll})/u;

/** A form the terminology table of STYLE.md says to avoid, as the lint finds it. */
export interface AvoidTerm {
  pattern: RegExp;
  /** The rows of the table it checks, by their Concept. */
  concepts: string[];
  /** A path prefix where the form is the right one. */
  except?: string;
}

/**
 * The forms to avoid, read from STYLE.md: the `avoid-term` block under the terminology
 * table. Each line is `/<regex>/<flags> <concept>[ + <concept>…][ (not in <path>)]`, or
 * `(reviewer) <concept>` for a row the lint cannot judge. Every row of the table has a line,
 * and every line names a row: the two cannot drift apart.
 */
export function readAvoidTerms(style = readFileSync(stylePath, "utf8")): AvoidTerm[] {
  const section = /^## Terminology\n([\s\S]*?)^## /m.exec(style)?.[1];
  if (!section) throw new Error("STYLE.md: no Terminology section");
  const rows = section
    .split("\n")
    .filter((line) => line.startsWith("|") && !TABLE_RULE.test(line))
    .map((line) => cells(line)[0] ?? "")
    .slice(1);
  const lines = /^```avoid-term\n([\s\S]*?)^```/m.exec(section)?.[1]?.split("\n") ?? [];
  if (lines.length === 0) throw new Error("STYLE.md: no avoid-term block under the table");
  const terms: AvoidTerm[] = [];
  const named = new Set<string>();
  for (const line of lines.filter((text) => text.trim() !== "")) {
    const parsed =
      /^(?:\/((?:\\.|[^\\/])+)\/([a-z]*)|\(reviewer\))\s+(.+?)(?:\s+\(not in (\S+)\))?$/.exec(line);
    if (!parsed) throw new Error(`STYLE.md: bad avoid-term line: ${line}`);
    const [, source, flags = "", list = "", except] = parsed;
    const concepts = list.split(" + ").map((concept) => concept.trim());
    for (const concept of concepts) {
      if (!rows.includes(concept))
        throw new Error(`STYLE.md: avoid-term names "${concept}", not a row of the table`);
      named.add(concept);
    }
    if (source) terms.push({ pattern: new RegExp(source, `${flags}g`), concepts, except });
  }
  const missing = rows.filter((row) => !named.has(row));
  if (missing.length > 0)
    throw new Error(
      `STYLE.md: no avoid-term line for ${missing.map((row) => `"${row}"`).join(", ")}`,
    );
  return terms;
}

let avoidTerms: AvoidTerm[] | undefined;

/** Lints one file; `path` is how its findings name it, relative to the repository. */
export function lintSource(
  path: string,
  source: string,
  terms = (avoidTerms ??= readAvoidTerms()),
): Finding[] {
  const kind = path.endsWith(".astro") ? "astro" : path.endsWith(".ts") ? "ts" : "markdown";
  let prose: Prose;
  try {
    prose = kind === "markdown" ? markdown(source) : sourceProse(source, kind);
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const findings: Finding[] = [];
  const report = (line: number, rule: Rule, detail: string) =>
    findings.push({ path, line, rule, detail });

  for (const block of prose.blocks) {
    const first = block.lines[0];
    if (!first) continue;
    const joined = block.lines.map(({ text }) => text).join("\n");
    const text = plain(joined);
    const count = words(text).length;
    if (count > MAX_PARAGRAPH_WORDS) report(first.line, "long-paragraph", `${count} words`);

    let offset = 0;
    for (const sentence of sentences(text)) {
      const line = first.line + joined.slice(0, offset).split("\n").length - 1;
      offset += sentence.length;
      const length = words(sentence).length;
      if (length > MAX_SENTENCE_WORDS) report(line, "long-sentence", `${length} words`);
      const semicolons = sentence.split(";").length - 1;
      const colons = sentence.split(":").length - 1;
      if (semicolons > 1 || (semicolons > 0 && colons > 0))
        report(line, "chained-clauses", `${semicolons} semicolons, ${colons} colons`);
    }
  }

  // A form to avoid, in prose: code spans, expressions, URLs and directives are set aside.
  const applies = terms.filter(({ except }) => !except || !path.startsWith(except));
  for (const block of [...prose.blocks, ...prose.headings]) {
    const first = block.lines[0];
    if (!first) continue;
    const text = plain(block.lines.map(({ text }) => text).join("\n")).replace(
      /"use (client|server|cache)"/g,
      (match) => word(match.length),
    );
    const seen = new Set<number>();
    for (const { pattern, concepts } of applies)
      for (const match of text.matchAll(pattern)) {
        const index = match.index ?? 0;
        if (seen.has(index)) continue;
        seen.add(index);
        const line = first.line + text.slice(0, index).split("\n").length - 1;
        report(line, "avoid-term", `"${match[0]}": ${concepts.join(", ")}`);
      }
  }

  // A blank line inside a sentence: MDX renders the rest as a new paragraph.
  if (kind === "markdown") {
    const lines = source.split("\n");
    const paragraphs = prose.blocks.filter((block) => !block.cell);
    for (const [index, block] of paragraphs.entries()) {
      const previous = paragraphs[index - 1];
      const first = block.lines[0];
      const last = previous?.lines.at(-1);
      if (!first || !last) continue;
      const between = lines.slice(last.line, first.line - 1);
      if (!between.every((line) => line.trim() === "" || COMMENT_ONLY.test(line.trim()))) continue;
      if (!lines[first.line - 1]?.trim().match(CONTINUES)) continue;
      if (LIST_ITEM.test(lines[first.line - 1]?.trim() ?? "")) continue;
      if (!ENDS_SENTENCE.test(last.text))
        report(first.line, "split-paragraph", `after line ${last.line}`);
    }
  }

  return exceptions(path, findings, prose.comments);
}

/** Applies the `prose-lint: allow` comments: each silences one finding on the next line. */
function exceptions(path: string, findings: Finding[], comments: Comment[]) {
  const kept = [...findings];
  const added: Finding[] = [];
  for (const comment of comments) {
    const match = ALLOW.exec(comment.text);
    const rule = match?.[1];
    if (!rule || !isRule(rule)) {
      added.push({
        path,
        line: comment.line,
        rule: "bad-allow",
        detail: "write `prose-lint: allow <rule> — <reason>`",
      });
      continue;
    }
    const silenced = kept.findIndex(
      (finding) => finding.line === comment.line + 1 && finding.rule === rule,
    );
    if (silenced === -1)
      added.push({ path, line: comment.line, rule: "unused-allow", detail: `no ${rule} below` });
    else kept.splice(silenced, 1);
  }
  return [...kept, ...added].sort((a, b) => a.line - b.line);
}

/** The files of a directory the lint reads: pages and Astro sources. */
function pages(directory: string, skip: string[] = []): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (skip.includes(path)) return [];
      if (entry.isDirectory()) return pages(path, skip);
      return /\.(mdx?|astro)$/.test(entry.name) ? [path] : [];
    })
    .sort();
}

/** The README of each directory of `directory` that has one. */
function readmes(directory: string) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(directory, entry.name, "README.md"))
    .filter((path) => existsSync(path))
    .sort();
}

/**
 * The site's sources that are not public: the lab and the Open Graph picture are out of the
 * sitemap (astro.config.mjs), and the docs' kit still lives in the French guide's folder.
 */
const NOT_PUBLIC = ["pages/lab", "pages/og.astro", "components/guide"].map((path) =>
  join(site, path),
);

/**
 * The public corpus, what a run reads by default: every docs page, the READMEs of the
 * repository, its packages and examples, the site's public pages with the components and
 * layouts they draw, and the modules that hold their text (the examples' blurbs, the
 * sections of the docs overview, the glossary's definitions).
 */
export function corpus() {
  return [
    ...pages(docs),
    join(root, "README.md"),
    ...readmes(join(root, "packages")),
    ...readmes(join(root, "examples")),
    ...["pages", "components", "layouts"].flatMap((directory) =>
      pages(join(site, directory), NOT_PUBLIC),
    ),
    join(site, "lib/examples.ts"),
    join(site, "lib/docs/nav.ts"),
    join(site, "lib/docs/glossary.ts"),
  ];
}

/** The files a run reads: the given files and directories, or the corpus. */
export function targets(paths: string[] = []) {
  if (paths.length === 0) return corpus();
  return paths
    .map((path) => resolve(path))
    .flatMap((path) => (statSync(path).isDirectory() ? pages(path) : [path]));
}

/** Each file that does not pass yet, with its count of findings. */
const Allowlist = z.record(z.string(), z.number().int().positive());
export type Allowlist = z.infer<typeof Allowlist>;

export function readAllowlist(path = allowlistPath): Allowlist {
  return Allowlist.parse(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * What the ratchet refuses, one message per file. `checked` are the files the run read,
 * relative to the repository. A listed file the run did not read is a page that is gone or
 * that the lint does not cover: it leaves the list too.
 */
export function ratchet(findings: Finding[], allowlist: Allowlist, checked: string[]) {
  const counts = new Map<string, number>();
  for (const { path } of findings) counts.set(path, (counts.get(path) ?? 0) + 1);
  const errors: string[] = [];
  for (const path of [...new Set([...checked, ...Object.keys(allowlist)])].sort()) {
    const count = counts.get(path) ?? 0;
    const allowed = allowlist[path];
    if (allowed === undefined) {
      if (count > 0)
        errors.push(`${path}: ${count} findings, and the file is not on the allowlist`);
    } else if (!checked.includes(path)) {
      errors.push(`${path}: not a page the lint reads, remove it from the allowlist`);
    } else if (count === 0) {
      errors.push(`${path}: no finding left, remove it from the allowlist`);
    } else if (count > allowed) {
      errors.push(`${path}: ${count} findings, the allowlist allows ${allowed}`);
    } else if (count < allowed) {
      errors.push(`${path}: ${count} findings, lower its count from ${allowed} to ${count}`);
    }
  }
  return errors;
}

/**
 * Lints the given paths (the corpus by default) and judges them against the allowlist. A
 * run on some paths judges only their entries.
 */
export function run(paths: string[] = [], allowlist = readAllowlist()) {
  const files = targets(paths).map((file) => relative(root, file));
  const findings = files.flatMap((file) =>
    lintSource(file, readFileSync(join(root, file), "utf8")),
  );
  const judged =
    paths.length === 0
      ? allowlist
      : Object.fromEntries(Object.entries(allowlist).filter(([path]) => files.includes(path)));
  return { files, findings, errors: ratchet(findings, judged, files) };
}

if (import.meta.main) {
  const { files, findings, errors } = run(process.argv.slice(2));
  for (const { path, line, rule, detail } of findings)
    console.log(`${path}:${line} ${rule} (${detail})`);
  for (const error of errors) console.error(`prose-lint: ${error}`);
  console.error(
    `prose-lint: ${findings.length} findings in ${files.length} files, ${errors.length} ratchet errors`,
  );
  process.exitCode = errors.length > 0 ? 1 : 0;
}
