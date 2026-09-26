import { RGBA, SyntaxStyle } from "@opentui/core";
import { color } from "./theme";

// Client-only: a SyntaxStyle is a native object and never crosses the Flight boundary.
// Replies arrive as Markdown text; styling happens here. OpenTUI 0.5.12 highlights
// JavaScript, TypeScript and Markdown itself; other fenced languages render as plain
// text (checked: not blank), so no grammar is downloaded at run time.
const hex = (value: string) => RGBA.fromHex(value);
export const syntax = SyntaxStyle.fromStyles({
  default: { fg: hex(color.text) },
  "markup.heading": { fg: hex(color.accent), bold: true },
  "markup.strong": { bold: true },
  "markup.italic": { italic: true },
  "markup.raw": { fg: hex("#a5d6ff") },
  "markup.link": { fg: hex(color.info), underline: true },
  "markup.list": { fg: hex(color.user) },
  "markup.quote": { fg: hex(color.muted), italic: true },
  keyword: { fg: hex(color.danger), bold: true },
  string: { fg: hex("#a5d6ff") },
  comment: { fg: hex("#8b949e"), italic: true },
  number: { fg: hex(color.info) },
  function: { fg: hex(color.thinking) },
  type: { fg: hex(color.user) },
});
export const muted = SyntaxStyle.fromStyles({ default: { fg: hex(color.muted) } });

const LANGUAGES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  md: "markdown",
};
/** The filetype OpenTUI highlights for `path`, or plain text. */
export const languageOf = (path: string) => LANGUAGES[path.split(".").at(-1) ?? ""] ?? "text";
