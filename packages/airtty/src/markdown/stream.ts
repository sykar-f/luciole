import { Lexer, type Links, type Token } from "marked";
import { closeTail } from "./close";
import { headingLevel, known, type Node, type Palette, renderBlock, spacing } from "./render";

/**
 * A streamed reply cut into its top-level blocks (after Streamdown). Every block but the
 * last is complete: its nodes are computed once and keep their identity, so a memoized view
 * never redraws them. The last block is the one still being written: it is closed
 * optimistically (`closeTail`) and redrawn at each delta.
 */
export type Block = {
  key: string;
  nodes: readonly Node[];
  /** Blank lines above the block. */
  marginTop: number;
};

const OPTIONS = { gfm: true };
// Link definitions resolve references anywhere: with one around, the reply is lexed whole.
const DEFINITION = /^ {0,3}\[[^\]]+\]:/m;
// Tokens re-lexed at each update even when their source did not change: the last ones can
// still merge with what follows (a paragraph's setext underline, a list's next item).
const UNSTABLE = 2;

type Rendered = { raw: string; tail: boolean; nodes: readonly Node[] };

export class MarkdownStream {
  readonly palette: Palette;
  private content = "";
  private tokens: Token[] = [];
  private links: Links = {};
  private rendered: Rendered[] = [];
  private blocks: Block[] = [];
  private streaming = false;

  constructor(palette: Palette) {
    this.palette = palette;
  }

  /** The blocks of `content`; the last one is still being written while `streaming`. */
  update(content: string, streaming: boolean): readonly Block[] {
    if (content === this.content && streaming === this.streaming) return this.blocks;
    const links = JSON.stringify(this.links);
    this.tokens = this.lex(content, streaming);
    // A new link definition can change any block that refers to it.
    if (JSON.stringify(this.links) !== links) this.rendered = [];
    this.content = content;
    this.streaming = streaming;
    const entries = this.tokens.filter((token) => token.type !== "space");
    const blocks: Block[] = [];
    const rendered: Rendered[] = [];
    let previous: Token | undefined;
    let gap = "";
    let index = 0;
    let lastHeading = 0;
    for (const token of this.tokens) {
      if (token.type === "space") {
        gap += token.raw;
        continue;
      }
      const tail = streaming && token === entries.at(-1);
      const cached = this.rendered[index];
      const nodes =
        cached && cached.raw === token.raw && cached.tail === tail
          ? cached.nodes
          : this.render(token, tail);
      rendered.push({ raw: token.raw, tail, nodes });
      const marginTop = previous ? spacing(previous, token, gap, lastHeading) : 0;
      lastHeading = headingLevel(token) || lastHeading;
      const reused = this.blocks[index];
      if (nodes.length) {
        blocks.push(
          reused && reused.nodes === nodes && reused.marginTop === marginTop
            ? reused
            : { key: String(index), nodes, marginTop },
        );
      }
      previous = token;
      gap = "";
      index++;
    }
    this.rendered = rendered;
    this.blocks = blocks;
    return blocks;
  }

  private render(token: Token, tail: boolean): readonly Node[] {
    if (!known(token)) return [];
    if (!tail || token.type === "code") return renderBlock(token, this.palette);
    if (token.type === "paragraph" && TABLE_ROWS.test(token.raw)) return [];
    const closed = closeTail(token.raw);
    if (closed === token.raw) return renderBlock(token, this.palette);
    // The closed text may lex differently (a hidden line, a completed span): lex it alone.
    const lexer = new Lexer(OPTIONS);
    Object.assign(lexer.tokens.links, this.links);
    const tokens = lexer.lex(closed);
    const nodes: Node[] = [];
    let previous: Token | undefined;
    let gap = "";
    let lastHeading = 0;
    for (const child of tokens) {
      if (child.type === "space") {
        gap += child.raw;
        continue;
      }
      if (!known(child) || (child.type === "paragraph" && TABLE_ROWS.test(child.raw))) continue;
      const own = renderBlock(child, this.palette);
      const first = own[0];
      if (first && previous) first.marginTop = spacing(previous, child, gap, lastHeading);
      lastHeading = headingLevel(child) || lastHeading;
      nodes.push(...own);
      previous = child;
      gap = "";
    }
    return nodes;
  }

  private lex(content: string, streaming: boolean): Token[] {
    if (!content.startsWith(this.content) || DEFINITION.test(content)) {
      const tokens = Lexer.lex(content, OPTIONS);
      const last = tokens.filter((token) => token.type !== "space").at(-1);
      // A definition still being written would redraw its references at every character.
      if (streaming && last && known(last) && last.type === "def") {
        const { [last.tag]: _pending, ...links } = tokens.links;
        this.links = links;
      } else this.links = tokens.links;
      return tokens;
    }
    this.links = {};
    let offset = 0;
    let reuse = 0;
    for (const token of this.tokens) {
      if (!content.startsWith(token.raw, offset)) break;
      offset += token.raw.length;
      reuse++;
    }
    reuse = Math.max(0, reuse - UNSTABLE);
    const kept = this.tokens.slice(0, reuse);
    const from = kept.reduce((sum, token) => sum + token.raw.length, 0);
    return [...kept, ...Lexer.lex(content.slice(from), OPTIONS)];
  }
}

// A paragraph of `|` lines at the tail is a table whose delimiter row has not arrived
// (`closeTail` already held back an unterminated row).
const TABLE_ROWS = /^\s*\|[^\n]*(?:\n\s*\|[^\n]*)*\s*$/;
