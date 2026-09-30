import { getTreeSitterClient, infoStringToFiletype, type SimpleHighlight } from "@opentui/core";
import { lexerFor } from "./lexical.ts";

// Code blocks colored by Tree-sitter, as luciole's `<Markdown>` colors them. Highlighting
// is asynchronous: until a block's text has its answer, the block keeps the colors of its
// previous text (typing in code does not flash it back to plain), then is drawn again.

export type Highlights = readonly SimpleHighlight[];

const MAX_ENTRIES = 256;
const NO_PARSER = /no parser/i;

export class Highlighter {
  private readonly known = new Map<string, Highlights>();
  private readonly asked = new Set<string>();
  /** Filetypes no grammar answered for: not asked again at every keystroke. */
  private readonly unsupported = new Set<string>();
  /** The last answer per code block, shown while its new text is being highlighted. */
  private readonly latest = new Map<number, Highlights>();
  private readonly onReady: () => void;

  constructor(onReady: () => void) {
    this.onReady = onReady;
  }

  /** Highlights for `text` in `lang`, or the block's previous ones while they are computed. */
  lookup(block: number, lang: string, text: string): Highlights | undefined {
    const lexer = lexerFor(lang);
    if (lexer && text) return this.lexed(lexer, lang, text);
    const filetype = lang ? (infoStringToFiletype(lang) ?? lang) : "";
    if (!filetype || !text || this.unsupported.has(filetype)) return undefined;
    const key = `${filetype}\u0000${text}`;
    const hit = this.known.get(key);
    if (hit) {
      this.latest.set(block, hit);
      return hit;
    }
    this.ask(key, filetype, text);
    return this.latest.get(block)?.filter(([, end]) => end <= text.length);
  }

  /** A language colored here, synchronously: remembered like Tree-sitter's answers. */
  private lexed(lexer: (text: string) => SimpleHighlight[], lang: string, text: string) {
    const key = `${lang}\u0000${text}`;
    const hit = this.known.get(key);
    if (hit) return hit;
    const highlights = lexer(text);
    this.remember(key, highlights);
    return highlights;
  }

  private ask(key: string, filetype: string, text: string) {
    if (this.asked.has(key)) return;
    this.asked.add(key);
    getTreeSitterClient()
      .highlightOnce(text, filetype)
      .then(
        (result) => {
          const reason = result.error ?? result.warning ?? "";
          if (!result.highlights?.length && NO_PARSER.test(reason)) this.unsupported.add(filetype);
          this.remember(key, result.highlights ?? []);
          this.onReady();
        },
        () => this.remember(key, []),
      )
      .finally(() => this.asked.delete(key));
  }

  private remember(key: string, highlights: Highlights) {
    this.known.set(key, highlights);
    if (this.known.size <= MAX_ENTRIES) return;
    const oldest = this.known.keys().next().value;
    if (oldest !== undefined) this.known.delete(oldest);
  }
}

/** The Tree-sitter groups over each character of a text of `length`, outermost first. */
export function groupsByOffset(
  highlights: Highlights,
  length: number,
): readonly (readonly string[])[] {
  const groups: string[][] = Array.from({ length }, () => []);
  // Outer ranges first, then, over the same text, the more specific group
  // (`function.method` after `variable`): the last one wins, as in OpenTUI's own renderer.
  const dots = (group: string) => group.split(".").length;
  const ordered = highlights
    .map((highlight, index) => ({ highlight, index }))
    .sort(
      ({ highlight: [a, aEnd, aGroup], index: i }, { highlight: [b, bEnd, bGroup], index: j }) =>
        a - b || bEnd - aEnd || dots(aGroup) - dots(bGroup) || i - j,
    )
    .map(({ highlight }) => highlight);
  for (const [start, end, group] of ordered)
    for (let i = Math.max(0, start); i < Math.min(length, end); i++) groups[i]?.push(group);
  return groups;
}
