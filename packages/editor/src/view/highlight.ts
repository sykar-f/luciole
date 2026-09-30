import { getTreeSitterClient, infoStringToFiletype, type SimpleHighlight } from "@opentui/core";

// Code blocks colored by Tree-sitter, as luciole's `<Markdown>` colors them. Highlighting
// is asynchronous: until a block's text has its answer, the block keeps the colors of its
// previous text (typing in code does not flash it back to plain), then is drawn again.

export type Highlights = readonly SimpleHighlight[];

const MAX_ENTRIES = 256;

export class Highlighter {
  private readonly known = new Map<string, Highlights>();
  private readonly asked = new Set<string>();
  /** The last answer per code block, shown while its new text is being highlighted. */
  private readonly latest = new Map<number, Highlights>();
  private readonly onReady: () => void;

  constructor(onReady: () => void) {
    this.onReady = onReady;
  }

  /** Highlights for `text` in `lang`, or the block's previous ones while they are computed. */
  lookup(block: number, lang: string, text: string): Highlights | undefined {
    const filetype = lang ? (infoStringToFiletype(lang) ?? lang) : "";
    if (!filetype || !text) return undefined;
    const key = `${filetype}\u0000${text}`;
    const hit = this.known.get(key);
    if (hit) {
      this.latest.set(block, hit);
      return hit;
    }
    this.ask(key, filetype, text);
    return this.latest.get(block)?.filter(([, end]) => end <= text.length);
  }

  private ask(key: string, filetype: string, text: string) {
    if (this.asked.has(key)) return;
    this.asked.add(key);
    getTreeSitterClient()
      .highlightOnce(text, filetype)
      .then(
        (result) => {
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
  const ordered = [...highlights].sort(([a, aEnd], [b, bEnd]) => a - b || bEnd - aEnd);
  for (const [start, end, group] of ordered)
    for (let i = Math.max(0, start); i < Math.min(length, end); i++) groups[i]?.push(group);
  return groups;
}
