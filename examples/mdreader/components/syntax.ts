import { RGBA, SyntaxStyle } from "@opentui/core";
import { color } from "./theme";

// Client-only: a SyntaxStyle is a native object and never crosses the Flight boundary.
// The Server sends Markdown text; tree-sitter highlights it here, code blocks included
// (JavaScript, TypeScript and Zig grammars ship with OpenTUI; others stay plain).
const hex = (value: string) => RGBA.fromHex(value);
export const syntax = SyntaxStyle.fromStyles({
  default: { fg: hex(color.text) },
  conceal: { fg: hex(color.faint) },
  "markup.heading": { fg: hex(color.accent), bold: true },
  "markup.heading.1": { fg: hex(color.accent), bold: true, underline: true },
  "markup.heading.2": { fg: hex(color.accent), bold: true },
  "markup.heading.3": { fg: hex(color.info), bold: true },
  "markup.heading.4": { fg: hex(color.violet), bold: true },
  "markup.heading.5": { fg: hex(color.violet) },
  "markup.heading.6": { fg: hex(color.muted), bold: true },
  "markup.strong": { bold: true },
  "markup.italic": { italic: true },
  "markup.strikethrough": { fg: hex(color.muted), dim: true },
  "markup.quote": { fg: hex(color.muted), italic: true },
  "markup.raw": { fg: hex(color.orange) },
  "markup.raw.block": { fg: hex(color.text) },
  "markup.link": { fg: hex(color.info), underline: true },
  "markup.link.label": { fg: hex(color.info), underline: true },
  "markup.link.url": { fg: hex(color.muted), underline: true },
  "markup.list": { fg: hex(color.orange) },
  "markup.list.checked": { fg: hex(color.ok) },
  "markup.list.unchecked": { fg: hex(color.muted) },
  "punctuation.special": { fg: hex(color.faint) },
  label: { fg: hex(color.muted) },
  keyword: { fg: hex("#ff7b72"), bold: true },
  "keyword.import": { fg: hex("#ff7b72"), bold: true },
  string: { fg: hex("#a5d6ff") },
  comment: { fg: hex("#8b949e"), italic: true },
  number: { fg: hex("#79c0ff") },
  boolean: { fg: hex("#79c0ff") },
  constant: { fg: hex("#79c0ff") },
  function: { fg: hex(color.violet) },
  "function.call": { fg: hex(color.violet) },
  "function.method": { fg: hex(color.violet) },
  type: { fg: hex(color.orange) },
  property: { fg: hex("#79c0ff") },
  operator: { fg: hex("#ff7b72") },
  punctuation: { fg: hex("#c9d1d9") },
  variable: { fg: hex(color.text) },
});
