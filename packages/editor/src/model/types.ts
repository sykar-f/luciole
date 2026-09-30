// The document an editor holds: Markdown's meaning, not its characters. Everything is
// immutable: an edit builds new blocks and keeps the untouched ones, which is how the
// serializer knows which blocks it may write back exactly as they were read.

/** Inline formatting. Absent means off; two runs with equal marks are one run. */
export type Marks = {
  readonly bold?: true;
  readonly italic?: true;
  readonly strike?: true;
  readonly code?: true;
  /** The link's target. */
  readonly link?: string;
  /** The link's title, when it has one (shown by some readers on hover). */
  readonly title?: string;
  /**
   * Source the editor shows and writes back as it is (an image, inline HTML): what it
   * does not model is kept, never rewritten.
   */
  readonly verbatim?: true;
  /**
   * Punctuation meant as itself (`\#`, `\*`): drawn plainly, never read as a marker, and
   * written back with its backslash.
   */
  readonly escaped?: true;
};
export type MarkName = "bold" | "italic" | "strike" | "code";

/** A run of text sharing its marks. A `"\n"` in `text` is a line break. */
export type Span = { readonly text: string; readonly marks: Marks };
/** A block's text: normalized, no empty run, no two neighbours with equal marks. */
export type Inline = readonly Span[];

export type ListKind = "bullet" | "ordered" | "task";
export type ListMarker = "-" | "*" | "+" | "." | ")";

/**
 * Where a block sits: in how many quotes, and in which list item. Every block has a place,
 * so a quote can hold a list, a heading or code, and an item can go on over paragraphs.
 * Quotes hold lists, never the other way round (a quote inside an item stays as written).
 */
export type Place = {
  /** How many quotes the block is in: `> > text` is 2. */
  readonly quote?: number;
  /** Starts a quote of its own, apart from the quoted block right above it. */
  readonly break?: true;
  /**
   * For a block other than an item: how many list levels it is inside. At 1 it goes on
   * the text of the item above at level 0 (a second paragraph, its code).
   */
  readonly depth?: number;
  /**
   * The block's Markdown as it was read (without its quotes' and list's prefixes). Only
   * blocks read from a document have it, and every edit builds a new block without it: an
   * unchanged block is written back as is.
   */
  readonly source?: string;
};

export type TextBlock =
  | ({ readonly type: "paragraph"; readonly content: Inline } & Place)
  | ({ readonly type: "heading"; readonly level: HeadingLevel; readonly content: Inline } & Place)
  | ({
      readonly type: "item";
      readonly list: ListKind;
      /** Its list's level, 0 at the margin. */
      readonly indent: number;
      /** Tasks only. */
      readonly checked?: boolean;
      /** The number of an ordered list's first item, when it is not 1. */
      readonly start?: number;
      /**
       * The character of its marker (`-`, `*` or `+`; `.` or `)` after a number): two
       * neighbouring lists are two lists because their markers differ.
       */
      readonly marker?: ListMarker;
      /** Items of a loose list are paragraphs, a blank line apart. */
      readonly loose?: true;
      readonly content: Inline;
    } & Place);
/** Blocks whose text is plain lines: code, and the Markdown kept as written. */
export type LinesBlock =
  | ({ readonly type: "code"; readonly lang: string; readonly text: string } & Place)
  /** A table, HTML, anything the editor does not model: edited as its Markdown. */
  | ({ readonly type: "raw"; readonly text: string } & Place);
export type RuleBlock = { readonly type: "rule" } & Place;
export type Block = TextBlock | LinesBlock | RuleBlock;
export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/** Never empty: an empty document is one empty paragraph. */
export type Doc = readonly Block[];

/** A place between two characters: `offset` counts UTF-16 units into the block's text. */
export type Pos = { readonly block: number; readonly offset: number };
/** `anchor` stays where the selection started, `head` moves (the cursor). */
export type Selection = { readonly anchor: Pos; readonly head: Pos };

export const isText = (block: Block): block is TextBlock =>
  block.type === "paragraph" || block.type === "heading" || block.type === "item";
export const isLines = (block: Block): block is LinesBlock =>
  block.type === "code" || block.type === "raw";

/** How many quotes `block` is in. */
export const quoteOf = (block: Block) => block.quote ?? 0;
/** How many list levels `block` is inside: an item's own level counts. */
export const levelOf = (block: Block) =>
  block.type === "item" ? block.indent + 1 : (block.depth ?? 0);
