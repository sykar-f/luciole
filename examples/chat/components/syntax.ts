import { RGBA, SyntaxStyle } from "@opentui/core";
import { color } from "./theme";

// Client-only: a SyntaxStyle is a native object and never crosses the Flight boundary.
// Replies arrive as Markdown text; styling happens here.
const hex = (value: string) => RGBA.fromHex(value);
export const syntax = SyntaxStyle.fromStyles({
  default: { fg: hex(color.text) },
  "markup.heading": { fg: hex(color.accent), bold: true },
  "markup.strong": { bold: true },
  "markup.italic": { italic: true },
  "markup.raw": { fg: hex("#a5d6ff") },
  "markup.link": { fg: hex(color.info), underline: true },
  "markup.list": { fg: hex("#ffa657") },
  "markup.quote": { fg: hex(color.muted), italic: true },
  keyword: { fg: hex(color.danger), bold: true },
  string: { fg: hex("#a5d6ff") },
  comment: { fg: hex("#8b949e"), italic: true },
  number: { fg: hex(color.info) },
  function: { fg: hex(color.user) },
  type: { fg: hex("#ffa657") },
});
