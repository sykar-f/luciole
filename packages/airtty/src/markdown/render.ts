import {
  createTextAttributes,
  type RGBA,
  type StyleDefinition,
  type SyntaxStyle,
  type TextChunk,
} from "@opentui/core";
import type { MarkedToken, Token, Tokens } from "marked";

/**
 * Markdown blocks to what the terminal draws, synchronously: no Tree-sitter pass, so what
 * a block shows while it streams is what it shows once done. The look is the one OpenTUI's
 * `<markdown conceal>` gives a finished reply (0.5.12, coalesced blocks): the source's lines
 * with their markers hidden, list bullets kept and colored, one blank line around code,
 * quotes, rules and tables.
 */

/** What one block draws: runs of styled text and the blocks text can't hold. */
export type Node =
  | { kind: "text"; chunks: readonly TextChunk[]; marginTop: number; indent: number }
  | {
      kind: "code";
      text: string;
      /** The fence's info string; highlighting waits for the closing fence. */
      lang: string;
      closed: boolean;
      marginTop: number;
      indent: number;
    }
  | { kind: "quote"; children: readonly Node[]; marginTop: number; indent: number }
  | { kind: "rule"; marginTop: number; indent: number }
  | { kind: "table"; raw: string; marginTop: number; indent: number };

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
/** Narrows marked's open `Token` union to the tokens it documents. */
export const known = (token: Token): token is MarkedToken => KINDS.has(token.type);
const tokensOf = (tokens: readonly Token[] | undefined) => (tokens ?? []).filter(known);

/** Blocks drawn apart from the text around them, one blank line away. */
export const separate = (token: Token) =>
  token.type === "code" ||
  token.type === "table" ||
  token.type === "blockquote" ||
  token.type === "hr";

const TRAILING_NEWLINES = /\n+$/;
const newlines = (text: string) => text.split("\n").length - 1;
/** Blank lines a gap of source text holds (`"\n\n"` holds one). */
export const blankLines = (gap: string) => Math.max(0, newlines(gap) - 1);

const FALLBACK_RULE = "#888888";

/**
 * Styles as OpenTUI's Markdown resolves them: a group, else its first segment, else the
 * default style. Nested spans combine: attributes add up, the innermost color wins.
 */
export class Palette {
  readonly hyperlinks: boolean;
  private readonly syntax: SyntaxStyle;
  private readonly cache = new Map<string, StyleDefinition | undefined>();

  constructor(syntax: SyntaxStyle, options: { hyperlinks: boolean }) {
    this.syntax = syntax;
    this.hyperlinks = options.hyperlinks;
  }
  private lookup(group: string) {
    if (this.cache.has(group)) return this.cache.get(group);
    let style = this.syntax.getStyle(group);
    if (!style && group.includes(".")) style = this.syntax.getStyle(group.split(".")[0] ?? "");
    this.cache.set(group, style);
    return style;
  }
  style(group: string): StyleDefinition | undefined {
    return this.lookup(group) ?? this.lookup("default");
  }
  /** `groups` from outermost to innermost; plain text (none) is drawn in the default style. */
  chunk(text: string, groups: readonly string[], link?: string): TextChunk {
    const styles = (groups.length ? groups : ["default"]).map((g) => this.style(g));
    let fg: RGBA | undefined;
    let bg: RGBA | undefined;
    const flags = { bold: false, italic: false, underline: false, dim: false };
    for (const style of styles) {
      if (!style) continue;
      fg = style.fg ?? fg;
      bg = style.bg ?? bg;
      flags.bold ||= style.bold === true;
      flags.italic ||= style.italic === true;
      flags.underline ||= style.underline === true;
      flags.dim ||= style.dim === true;
    }
    return {
      __isChunk: true,
      text,
      fg,
      bg,
      attributes: createTextAttributes(flags),
      ...(link === undefined ? {} : { link: { url: link } }),
    };
  }
  /** The color of rules and quote bars. */
  line(): RGBA | string {
    return this.lookup("conceal")?.fg ?? FALLBACK_RULE;
  }
  quoteBar(): RGBA | string {
    return this.lookup("conceal")?.fg ?? this.lookup("default")?.fg ?? FALLBACK_RULE;
  }
}

/** Collects styled text line by line, indenting continuation lines, splitting at blocks. */
class Builder {
  readonly nodes: Node[] = [];
  private chunks: TextChunk[] = [];
  private indent = "";
  private lineOpen = false;
  private blank = 0;
  private leading = 0;
  private readonly palette: Palette;
  private readonly base: readonly string[];

  constructor(palette: Palette, base: readonly string[]) {
    this.palette = palette;
    this.base = base;
  }
  get currentIndent() {
    return this.indent;
  }
  /** Text in `groups` (on top of the builder's base); newlines keep the current indent. */
  text(text: string, groups: readonly string[] = [], link?: string) {
    text.split("\n").forEach((line, i) => {
      if (i > 0) {
        if (this.lineOpen) this.lineOpen = false;
        else if (this.chunks.length) this.blank++;
      }
      if (!line) return;
      this.open();
      this.chunks.push(this.palette.chunk(line, [...this.base, ...groups], link));
    });
  }
  private open() {
    if (this.lineOpen) return;
    if (this.chunks.length)
      this.chunks.push(this.palette.chunk("\n".repeat(this.blank + 1), this.base));
    else this.leading = this.blank;
    this.blank = 0;
    this.lineOpen = true;
    if (this.indent) this.chunks.push(this.palette.chunk(this.indent, this.base));
  }
  /** Ends the current line; the next text starts a new one. */
  newline() {
    this.lineOpen = false;
  }
  blankLines(count: number) {
    this.newline();
    this.blank += count;
  }
  within(indent: string, work: () => void) {
    const outer = this.indent;
    this.indent = indent;
    work();
    this.indent = outer;
  }
  /** A block text can't hold, at the current indent, after the blank lines pending. */
  block(node: DistributiveOmit<Node, "marginTop" | "indent">) {
    const marginTop = this.chunks.length ? this.blank : this.leading + this.blank;
    this.flush();
    this.nodes.push({ ...node, marginTop, indent: this.indent.length });
  }
  flush() {
    if (this.chunks.length)
      this.nodes.push({ kind: "text", chunks: this.chunks, marginTop: this.leading, indent: 0 });
    this.chunks = [];
    this.lineOpen = false;
    this.blank = 0;
    this.leading = 0;
  }
}
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** One top-level block (or a quote's inner block) as nodes; `base` styles all its text. */
export function renderBlock(token: MarkedToken, palette: Palette, base: readonly string[] = []) {
  const out = new Builder(palette, base);
  block(token, out, palette, base);
  out.flush();
  return out.nodes;
}

function block(token: MarkedToken, out: Builder, palette: Palette, base: readonly string[]) {
  switch (token.type) {
    case "paragraph":
      inline(tokensOf(token.tokens), out, [], palette);
      return;
    case "text":
      if (token.tokens) inline(tokensOf(token.tokens), out, [], palette);
      else out.text(token.text);
      return;
    case "heading": {
      inline(tokensOf(token.tokens), out, [], palette);
      // Setext: the underline stays, as in the source.
      const underline = /\n( {0,3}(?:=+|-+)[ \t]*)\n*$/.exec(token.raw);
      if (underline?.[1] && !token.raw.trimStart().startsWith("#")) out.text(`\n${underline[1]}`);
      return;
    }
    case "html":
    case "def":
      out.text(token.raw.replace(TRAILING_NEWLINES, ""));
      return;
    case "list":
      list(token, out, palette, base);
      return;
    case "code":
      out.block(code(token));
      return;
    case "blockquote":
      out.block({ kind: "quote", children: quote(token, palette, base) });
      return;
    case "hr":
      out.block({ kind: "rule" });
      return;
    case "table":
      out.block({ kind: "table", raw: token.raw.replace(TRAILING_NEWLINES, "") });
      return;
    case "space":
      out.blankLines(blankLines(token.raw));
      return;
    default:
      out.text(token.raw.replace(TRAILING_NEWLINES, ""));
  }
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

function code(token: Tokens.Code) {
  const fence = FENCE_OPEN.exec(token.raw)?.[1];
  if (!fence) return { kind: "code" as const, text: token.text, lang: "", closed: true };
  const lines = token.raw.replace(TRAILING_NEWLINES, "").split("\n");
  const last = (lines.at(-1) ?? "").trim();
  const closed =
    lines.length > 1 &&
    last.length >= fence.length &&
    last === (fence[0] ?? "").repeat(last.length);
  // A closing fence half typed (`` ` `` of three) is no code line.
  const text =
    !closed && /^ {0,3}(`+|~+)\s*$/.test(lines.at(-1) ?? "") && lines.length > 1
      ? token.text.split("\n").slice(0, -1).join("\n")
      : token.text;
  return { kind: "code" as const, text, lang: token.lang ?? "", closed };
}

/** A quote's content: its own blocks, drawn in the quote style. */
function quote(token: Tokens.Blockquote, palette: Palette, base: readonly string[]) {
  const inner = [...base, "markup.quote"];
  const nodes: Node[] = [];
  let gap = "";
  let previous: Token | undefined;
  for (const child of tokensOf(token.tokens)) {
    if (child.type === "space") {
      gap += child.raw;
      continue;
    }
    const rendered = renderBlock(child, palette, inner);
    const first = rendered[0];
    if (first && previous) {
      // Inside a quote, blocks keep the source's spacing (OpenTUI draws a quote as text).
      first.marginTop = blankLines((TRAILING_NEWLINES.exec(previous.raw)?.[0] ?? "") + gap);
    }
    nodes.push(...rendered);
    previous = child;
    gap = "";
  }
  return nodes;
}

const LIST_MARKER = /^( *)([-*+]|\d{1,9}[.)])( {0,4})/;

function list(token: Tokens.List, out: Builder, palette: Palette, base: readonly string[]) {
  token.items.forEach((item, index) => {
    if (index > 0) {
      const previous = token.items[index - 1]?.raw ?? "";
      out.blankLines(blankLines(TRAILING_NEWLINES.exec(previous)?.[0] ?? ""));
    }
    const match = LIST_MARKER.exec(item.raw);
    const lead = match?.[1] ?? "";
    const marker = match?.[2] ?? "-";
    const spacing = match?.[3] || " ";
    out.text(lead);
    out.text(`${marker}${spacing.slice(0, 1)}`, ["markup.list"]);
    if (spacing.length > 1) out.text(spacing.slice(1));
    const content = " ".repeat(lead.length + marker.length + spacing.length);
    out.within(`${out.currentIndent}${content}`, () => {
      let first = true;
      for (const child of tokensOf(item.tokens)) {
        if (child.type === "checkbox") {
          out.text(child.raw);
          continue;
        }
        if (child.type === "space") {
          out.blankLines(blankLines(child.raw));
          continue;
        }
        if (!first && !separate(child)) out.newline();
        first = false;
        block(child, out, palette, base);
      }
    });
    out.newline();
  });
}

/** Inline tokens, markers hidden. `groups`: the spans they sit in, outermost first. */
function inline(
  tokens: readonly MarkedToken[],
  out: Builder,
  groups: readonly string[],
  palette: Palette,
  link?: string,
) {
  for (const token of tokens) {
    switch (token.type) {
      case "text":
        if (token.tokens) inline(tokensOf(token.tokens), out, groups, palette, link);
        else out.text(token.text, groups, link);
        break;
      case "escape":
        out.text(token.text, groups, link);
        break;
      case "codespan":
        out.text(token.text, [...groups, "markup.raw"], link);
        break;
      case "strong":
        inline(tokensOf(token.tokens), out, [...groups, "markup.strong"], palette, link);
        break;
      case "em":
        inline(tokensOf(token.tokens), out, [...groups, "markup.italic"], palette, link);
        break;
      case "del":
        inline(tokensOf(token.tokens), out, [...groups, "markup.strikethrough"], palette, link);
        break;
      case "link": {
        inline(tokensOf(token.tokens), out, [...groups, "markup.link.label"], palette, token.href);
        const bare = token.raw === token.text || token.raw === `<${token.text}>`;
        // A terminal with hyperlinks makes the label clickable; others show where it leads.
        if (!palette.hyperlinks && !bare && token.text !== token.href) {
          out.text(" ", groups);
          out.text("(", [...groups, "markup.link"], token.href);
          out.text(token.href, [...groups, "markup.link.url"], token.href);
          out.text(")", [...groups, "markup.link"], token.href);
        }
        break;
      }
      case "image":
        out.text(token.text || "image", [...groups, "markup.link.label"], link ?? token.href);
        break;
      case "br":
        out.text("\n", groups, link);
        break;
      case "html":
        out.text(token.raw, groups, link);
        break;
      default:
        out.text(token.raw, groups, link);
    }
  }
}
