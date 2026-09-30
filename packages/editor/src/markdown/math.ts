import { Marked, type TokenizerExtension } from "marked";

// Math as GitHub writes it: `$…$` and `` $`…`$ `` in text, `$$…$$` as a block (a ```math
// fence is code, read as such). Marked knows none of it: without these tokens, the stars
// and underscores of `$a_1 * b_2$` would be read as emphasis. Tokens the editor does not
// model are kept as written (a verbatim span, a raw block), so math is never rewritten.

// GitHub's rules: no space just inside the dollars, no digit right after the closing one
// (`$5 and $10` is money).
const INLINE = /^\$`([^`\n]+)`\$|^\$(?![\s$])((?:\\.|[^$\n\\])+?)(?<!\s)\$(?!\d)/;
const BLOCK = /^ {0,3}\$\$([\s\S]+?)\$\$[ \t]*(?:\n|$)/;

const inline: TokenizerExtension = {
  name: "inlineMath",
  level: "inline",
  start: (src) => {
    const at = src.indexOf("$");
    return at < 0 ? undefined : at;
  },
  tokenizer: (src) => {
    const match = INLINE.exec(src);
    if (!match) return undefined;
    return { type: "inlineMath", raw: match[0], text: match[1] ?? match[2] ?? "" };
  },
};
const block: TokenizerExtension = {
  name: "blockMath",
  level: "block",
  start: (src) => /^ {0,3}\$\$/m.exec(src)?.index,
  tokenizer: (src) => {
    const match = BLOCK.exec(src);
    if (!match) return undefined;
    return { type: "blockMath", raw: match[0], text: (match[1] ?? "").trim() };
  },
};

const reader = new Marked({ gfm: true, extensions: [block, inline] });
/** Markdown to marked's tokens, math included. */
export const lex = (markdown: string) => reader.lexer(markdown);

/** The TeX of math written as `$…$`, `` $`…`$ `` or `$$…$$`, or null for anything else. */
export function texOf(source: string): { tex: string; display: boolean } | null {
  const display = /^\s*\$\$([\s\S]+?)\$\$\s*$/.exec(source);
  if (display) return { tex: (display[1] ?? "").trim(), display: true };
  const inside = INLINE.exec(source);
  if (inside && inside[0] === source) return { tex: inside[1] ?? inside[2] ?? "", display: false };
  return null;
}
