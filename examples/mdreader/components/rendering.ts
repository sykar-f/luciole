import {
  BoxRenderable,
  TextRenderable,
  type MarkdownOptions,
  type MarkdownRenderable,
  type Renderable,
} from "@opentui/core";
import { color } from "./theme";

// Client-only helpers around OpenTUI's MarkdownRenderable, which parses (marked) and
// highlights (tree-sitter) the document itself: nothing here parses Markdown.

type RenderNode = NonNullable<MarkdownOptions["renderNode"]>;
/**
 * Fenced code blocks on a darker panel, with their language. `codeBlockOnly` keeps the
 * renderable's default layout for everything else (prose grouped into large blocks).
 */
export const codeBlocks: RenderNode = Object.assign<RenderNode, { codeBlockOnly: true }>(
  (token, context) => {
    if (token.type !== "code") return undefined;
    const code = context.defaultRender();
    if (!code) return code;
    const panel = new BoxRenderable(code.ctx, {
      width: "100%",
      flexShrink: 0,
      flexDirection: "column",
      backgroundColor: color.code,
      paddingX: 1,
      marginBottom: 0,
    });
    const language = typeof token.lang === "string" ? token.lang.trim().split(/\s+/)[0] : "";
    if (language)
      panel.add(new TextRenderable(code.ctx, { content: language, fg: color.faint, height: 1 }));
    panel.add(code);
    return panel;
  },
  { codeBlockOnly: true },
);

export type Heading = { level: number; text: string; top: number };

type WithLines = Renderable & { lineInfo: { lineSources: number[] } };
const hasLines = (renderable: Renderable): renderable is WithLines => "lineInfo" in renderable;

/** Heading text without its inline Markdown, for the outline. */
const plain = (text: string) =>
  text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~]/g, "")
    .trim();

/** Offset of `needle` at the start of a line of `text`, from `from`, or -1. */
function lineStart(text: string, needle: string, from: number) {
  for (let at = text.indexOf(needle, from); at >= 0; at = text.indexOf(needle, at + 1))
    if (at === 0 || text[at - 1] === "\n") return at;
  return -1;
}

/**
 * Rows of the top-level headings, relative to `origin` (the scrolled content's top).
 * The renderable groups consecutive prose tokens into one highlighted text block: a
 * heading is found in its block's source, then its source line is mapped to the wrapped
 * row the block actually draws. Uses the renderable's public but internal state
 * (`_parseState`, `_blockStates`): see README, limits.
 */
export function locateHeadings(markdown: MarkdownRenderable, origin: number): Heading[] {
  const headings = (markdown._parseState?.tokens ?? []).flatMap((t) =>
    t.type === "heading" ? [t] : [],
  );
  const found: Heading[] = [];
  let next = 0;
  for (const block of markdown._blockStates) {
    if (next >= headings.length) break;
    const { renderable, tokenRaw } = block;
    if (block.token.type !== "paragraph" && block.token.type !== "heading") continue;
    const sources = hasLines(renderable) ? renderable.lineInfo.lineSources : [];
    let from = 0;
    while (next < headings.length) {
      const heading = headings[next];
      const needle = heading.raw.replace(/\n+$/, "");
      const at = lineStart(tokenRaw, needle, from);
      if (at < 0) break;
      const line = tokenRaw.slice(0, at).split("\n").length - 1;
      const row = Math.max(0, sources.indexOf(line));
      found.push({
        level: heading.depth,
        text: plain(heading.text),
        top: renderable.y - origin + row,
      });
      from = at + needle.length;
      next++;
    }
  }
  return found;
}
