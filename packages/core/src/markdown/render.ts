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
 * quotes, rules and tables. Headings differ: each level has its own band and spacing.
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
      /** A diff, colored here line by line (no grammar): the same while it streams. */
      diff?: readonly TextChunk[];
      marginTop: number;
      indent: number;
    }
  | { kind: "quote"; children: readonly Node[]; marginTop: number; indent: number }
  | { kind: "rule"; marginTop: number; indent: number }
  | {
      kind: "image";
      /** As written: a URL, or a path the view resolves. */
      src: string;
      /** Its alternative text, a link to it, shown until it loads or if it can't. */
      alt: readonly TextChunk[];
      marginTop: number;
      indent: number;
    }
  | {
      kind: "heading";
      /** 1 to 3: deeper headings are drawn as level 3. */
      level: number;
      chunks: readonly TextChunk[];
      /** The band behind the title (the level's `bg`), fading out to the right. */
      band: RGBA | undefined;
      marginTop: number;
      indent: number;
    }
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
const HEADING_LEVELS = 3;
/** A heading's level as drawn (1 to 3), or 0 for any other block. */
export const headingLevel = (token: Token) =>
  known(token) && token.type === "heading" ? Math.min(token.depth, HEADING_LEVELS) : 0;
// Blank lines above a heading of each level, and below it: an H3 sticks to its content.
const ABOVE: Readonly<Record<number, number>> = { 1: 2, 2: 1, 3: 1 };
const BELOW: Readonly<Record<number, number>> = { 1: 1, 2: 1, 3: 0 };

/**
 * Blank lines between two blocks. Headings set their own: above them by level (two above
 * an H2 that ends an H3's subsection), below them by the heading's level. Elsewhere one line
 * around blocks drawn apart, else the blank lines of the source.
 */
export function spacing(previous: Token, token: Token, gap: string, lastHeading: number) {
  const above = headingLevel(token);
  const below = headingLevel(previous);
  if (above) {
    const lines = above === 2 && lastHeading === HEADING_LEVELS ? 2 : (ABOVE[above] ?? 1);
    return below ? Math.max(lines, BELOW[below] ?? 1) : lines;
  }
  if (below) return BELOW[below] ?? 1;
  if (separate(previous) || separate(token)) return 1;
  return blankLines((TRAILING_NEWLINES.exec(previous.raw)?.[0] ?? "") + gap);
}
const newlines = (text: string) => text.split("\n").length - 1;
/** Blank lines a gap of source text holds (`"\n\n"` holds one). */
export const blankLines = (gap: string) => Math.max(0, newlines(gap) - 1);

const FALLBACK_RULE = "#888888";
const HEADING = "markup.heading";

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
    // A group, then its parents: `markup.link.label`, `markup.link`, `markup`.
    let style: StyleDefinition | undefined;
    for (let name = group; name && !style; name = name.slice(0, Math.max(0, name.lastIndexOf("."))))
      style = this.syntax.getStyle(name);
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
  /** The band behind a heading of `level`: its style's background, if it has one. */
  band(level: number): RGBA | undefined {
    return this.lookup(`${HEADING}.${level}`)?.bg;
  }
  /** The color of rules and quote bars. */
  /** The background of a code block (`markup.raw.block`), if the style gives one. */
  codeBlock(): RGBA | undefined {
    return this.lookup("markup.raw.block")?.bg;
  }
  /** The color of labels that stand for something else: a code block's language. */
  label(): RGBA | undefined {
    return this.lookup("comment")?.fg ?? this.lookup("default")?.fg;
  }
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
    case "paragraph": {
      const children = tokensOf(token.tokens);
      const images = children.filter((child) => child.type === "image");
      // A paragraph of images alone is those images; around text, they follow it.
      const alone = children.every(
        (child) => child.type === "image" || (child.type === "text" && !child.text.trim()),
      );
      if (!images.length || !alone) inline(children, out, [], palette);
      for (const image of images) {
        const alt = new Builder(palette, base);
        inline([image], alt, [], palette);
        alt.flush();
        const first = alt.nodes[0];
        out.block({
          kind: "image",
          src: image.href,
          alt: first?.kind === "text" ? first.chunks : [],
        });
      }
      return;
    }
    case "text":
      if (token.tokens) inline(tokensOf(token.tokens), out, [], palette);
      else out.text(token.text);
      return;
    case "heading": {
      const level = headingLevel(token);
      // Inside a list or a quote, a heading is text in its level's style.
      if (base.length) {
        inline(tokensOf(token.tokens), out, [`${HEADING}.${level}`], palette);
        return;
      }
      const title = new Builder(palette, [`${HEADING}.${level}`]);
      inline(tokensOf(token.tokens), title, [], palette);
      title.flush();
      const first = title.nodes[0];
      // The band is drawn behind the whole row, the text keeps no background of its own.
      const chunks =
        first?.kind === "text" ? first.chunks.map((c) => ({ ...c, bg: undefined })) : [];
      out.block({ kind: "heading", level, chunks, band: palette.band(level) });
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
      out.block(code(token, palette));
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

const DIFF_LANGUAGES = new Set(["diff", "patch", "udiff"]);
/** The style group of a diff line, by its first characters. */
const diffGroup = (line: string) =>
  /^(diff |index |\+\+\+ |--- )/.test(line)
    ? "diff.header"
    : line.startsWith("@@")
      ? "diff.delta"
      : line.startsWith("+")
        ? "diff.plus"
        : line.startsWith("-")
          ? "diff.minus"
          : undefined;

function diffChunks(text: string, palette: Palette) {
  return text.split("\n").flatMap((line, i) => {
    const group = diffGroup(line);
    const chunks = line ? [palette.chunk(line, group ? [group] : [])] : [];
    return i ? [palette.chunk("\n", []), ...chunks] : chunks;
  });
}

function code(token: Tokens.Code, palette: Palette) {
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
  const lang = token.lang ?? "";
  const diff = DIFF_LANGUAGES.has(lang.trim().split(/\s+/)[0]?.toLowerCase() ?? "")
    ? diffChunks(text, palette)
    : undefined;
  return { kind: "code" as const, text, lang, closed, ...(diff ? { diff } : {}) };
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
