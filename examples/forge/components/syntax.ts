import { RGBA, SyntaxStyle } from "@opentui/core";

// Client-only: a SyntaxStyle is a native object and never crosses the Flight boundary.
// The Server sends plain patches and source text; highlighting happens here.
const hex = RGBA.fromHex;
export const syntax = SyntaxStyle.fromStyles({
  default: { fg: hex("#e6edf3") },
  keyword: { fg: hex("#ff7b72"), bold: true },
  "keyword.import": { fg: hex("#ff7b72"), bold: true },
  string: { fg: hex("#a5d6ff") },
  comment: { fg: hex("#8b949e"), italic: true },
  number: { fg: hex("#79c0ff") },
  boolean: { fg: hex("#79c0ff") },
  constant: { fg: hex("#79c0ff") },
  function: { fg: hex("#d2a8ff") },
  "function.call": { fg: hex("#d2a8ff") },
  type: { fg: hex("#ffa657") },
  property: { fg: hex("#79c0ff") },
  operator: { fg: hex("#ff7b72") },
  punctuation: { fg: hex("#c9d1d9") },
  variable: { fg: hex("#e6edf3") },
  "markup.heading": { fg: hex("#67d9bc"), bold: true },
  "markup.strong": { bold: true },
  "markup.italic": { italic: true },
  "markup.raw": { fg: hex("#a5d6ff") },
  "markup.link": { fg: hex("#79c0ff"), underline: true },
  "markup.list": { fg: hex("#ffa657") },
});
