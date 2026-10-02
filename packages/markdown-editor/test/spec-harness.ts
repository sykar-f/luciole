// What a piece of Markdown shows, for comparing two of them. marked (the reader luciole
// draws notes with) renders it to HTML; the HTML is then reduced to what a terminal can
// show: blocks, and runs of text each with its set of styles. What is drawn the same is
// compared the same: `<em><a>` and `<a><em>`, italic inside italic, a link inside a link,
// `&copy;` and `©`, a soft line break and a hard one.
import { Marked } from "marked";
import { splitReferences } from "../src/model/entities.ts";
import { parseMarkdown } from "../src/markdown/parse.ts";
import { serializeMarkdown } from "../src/markdown/serialize.ts";
import type { Block, Doc } from "../src/model/types.ts";

const marked = new Marked({ gfm: true });
const INLINE = new Set(["em", "strong", "del", "code", "a"]);

type Piece = { tag: string } | { key: string; text: string; code: boolean };

export function meaning(markdown: string): string {
  const html = marked.parse(markdown, { async: false }).replace(/<br>\n?/g, "\n");
  const pieces: Piece[] = [];
  const styles: { name: string; attributes: string }[] = [];
  let pre = 0;
  for (const part of html.split(/(<[^>]+>)/)) {
    if (!part) continue;
    const tag = /^<(\/?)([a-zA-Z0-9]+)([^>]*)>$/.exec(part);
    if (tag) {
      const [, closing, name = "", attributes = ""] = tag;
      if (INLINE.has(name)) {
        if (closing) {
          const at = styles.findLastIndex((style) => style.name === name);
          if (at >= 0) styles.splice(at, 1);
        } else styles.push({ name, attributes: attributes.trim() });
        continue;
      }
      if (name === "pre") pre += closing ? -1 : 1;
      pieces.push({ tag: `<${closing}${name}${attributes.replace(/\s+/g, " ")}>` });
      continue;
    }
    const text = splitReferences(part)
      .map((reference) => reference.text)
      .join("");
    const code = pre > 0 || styles.some((style) => style.name === "code");
    // In a link inside a link, the inner one is clicked (a browser ends the outer one
    // where the inner one starts); styles are a set.
    const link = styles.findLast((style) => style.name === "a");
    const names = [...new Set(styles.map((style) => style.name))].sort();
    const key = `${names.join("+")}${link ? `(${link.attributes})` : ""}`;
    pieces.push({ key, text: code ? text : text.replace(/[ \t\r\n]+/g, " "), code });
  }
  // Equal neighbours join; spaces at the edges of a block are not drawn (outside code).
  const merged: Piece[] = [];
  for (const piece of pieces) {
    const last = merged.at(-1);
    if (last && !("tag" in last) && !("tag" in piece) && last.key === piece.key)
      merged[merged.length - 1] = { ...last, text: last.text + piece.text };
    else merged.push(piece);
  }
  // Spaces alone at a block's edge are not drawn: their neighbour is then at the edge.
  const edge = (piece: Piece | undefined) => !piece || "tag" in piece;
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = merged.length - 1; i >= 0; i--) {
      const piece = merged[i];
      if (!piece || "tag" in piece || piece.code || piece.text.trim()) continue;
      if (edge(merged[i - 1]) || edge(merged[i + 1])) {
        merged.splice(i, 1);
        changed = true;
      }
    }
  }
  return merged
    .map((piece, i) => {
      if ("tag" in piece) return piece.tag;
      let text = piece.text;
      const before = merged[i - 1];
      const after = merged[i + 1];
      if (!piece.code && (!before || "tag" in before)) text = text.trimStart();
      if (!piece.code && (!after || "tag" in after)) text = text.trimEnd();
      return text ? `${piece.key}«${text}»` : "";
    })
    .join("");
}

/** A block without the source it was read from: written back from its meaning. */
export const fresh = (block: Block): Block => {
  const { source: _, ...rest } = { source: undefined, ...block };
  return rest;
};
/** The document rewritten from scratch: every block from its meaning. */
export const rewrite = (markdown: string) => serializeMarkdown(parseMarkdown(markdown).map(fresh));
export const rewriteDoc = (doc: Doc) => serializeMarkdown(doc.map(fresh));
