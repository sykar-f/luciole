import "server-only";
import { Lexer } from "marked";

// OpenTUI draws prose as highlighted source text: a paragraph keeps the line breaks of
// the file. Files are often wrapped near 80 columns, so in a narrower pane every source
// line ends in a short orphan. Soft breaks of paragraphs and list items are joined here,
// with the lexer OpenTUI itself uses (marked), and the renderer wraps at the pane's
// width. Hard breaks (two trailing spaces, backslash) and everything else stay as is.

const HARD_BREAK = /( {2}|\\)$/;
const SOFT_BREAK = /(?<! {2}|\\)\n[ \t]*(?=\S)/g;
// A list line that starts something of its own is never joined to the previous one.
const OWN_LINE = /^\s*([-*+]|\d{1,9}[.)])(\s|$)|^\s*(>|#|\||<|```|~~~|([-*_]\s*){3,}$)/;
const FENCE = /^\s*(```|~~~)/m;

function joinListLines(raw: string) {
  // Code inside a list item keeps its lines: leave such a list untouched.
  if (FENCE.test(raw)) return raw;
  const lines: string[] = [];
  for (const line of raw.split("\n")) {
    const previous = lines.at(-1);
    if (previous?.trim() && line.trim() && !HARD_BREAK.test(previous) && !OWN_LINE.test(line))
      lines[lines.length - 1] = `${previous} ${line.trim()}`;
    else lines.push(line);
  }
  return lines.join("\n");
}

/** The document with soft line breaks joined; replaced in place, so link definitions stay. */
export function reflow(markdown: string) {
  let done = 0;
  let result = "";
  for (const token of Lexer.lex(markdown)) {
    if (token.type !== "paragraph" && token.type !== "list") continue;
    const at = markdown.indexOf(token.raw, done);
    if (at < 0) continue;
    const joined =
      token.type === "paragraph" ? token.raw.replace(SOFT_BREAK, " ") : joinListLines(token.raw);
    result += markdown.slice(done, at) + joined;
    done = at + token.raw.length;
  }
  return result + markdown.slice(done);
}
