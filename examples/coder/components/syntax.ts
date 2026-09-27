import { RGBA, SyntaxStyle } from "@opentui/core";
// Grammars beyond JavaScript, TypeScript and Markdown, for replies and diffs alike.
import "airtty/grammars";
import { color } from "./theme";

// Client-only: a SyntaxStyle is a native object and never crosses the Flight boundary.
// Replies arrive as Markdown text; styling happens here. OpenTUI 0.5.12 highlights
// JavaScript, TypeScript and Markdown itself, airtty/grammars adds the languages below;
// any other renders as plain text (checked: not blank). No grammar is downloaded at run
// time: they ship with the build.
const hex = (value: string) => RGBA.fromHex(value);
export const syntax = SyntaxStyle.fromStyles({
  default: { fg: hex(color.text) },
  "markup.heading": { fg: hex(color.accent), bold: true },
  // Headings on a band that fades out: accent for the top levels, a neutral panel below.
  "markup.heading.1": { fg: hex(color.white), bg: hex(color.accentDim), bold: true },
  "markup.heading.2": { fg: hex(color.white), bg: hex(color.accentDim), bold: true },
  "markup.heading.3": { fg: hex(color.accent), bg: hex(color.band), bold: true },
  "markup.strong": { bold: true },
  "markup.italic": { italic: true },
  "markup.raw": { fg: hex("#a5d6ff") },
  // Code blocks sit on a plain panel.
  "markup.raw.block": { bg: hex(color.panel) },
  "markup.link": { fg: hex(color.info), underline: true },
  "markup.list": { fg: hex(color.user) },
  "markup.quote": { fg: hex(color.muted), italic: true },
  keyword: { fg: hex(color.danger), bold: true },
  string: { fg: hex("#a5d6ff") },
  "string.special": { fg: hex("#a5d6ff") },
  escape: { fg: hex(color.info) },
  comment: { fg: hex("#8b949e"), italic: true },
  number: { fg: hex(color.info) },
  boolean: { fg: hex(color.info) },
  constant: { fg: hex(color.info) },
  property: { fg: hex(color.info) },
  attribute: { fg: hex(color.info) },
  label: { fg: hex(color.info) },
  function: { fg: hex(color.thinking) },
  type: { fg: hex(color.user) },
  constructor: { fg: hex(color.user) },
  module: { fg: hex(color.user) },
  namespace: { fg: hex(color.user) },
  "variable.builtin": { fg: hex(color.user) },
  tag: { fg: hex(color.ok) },
  // Code blocks tagged diff or patch, colored line by line.
  "diff.plus": { fg: hex(color.ok) },
  "diff.minus": { fg: hex(color.danger) },
  "diff.delta": { fg: hex(color.info) },
  "diff.header": { fg: hex(color.muted), bold: true },
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
  py: "python",
  rs: "rust",
  go: "go",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  json: "json",
  css: "css",
  html: "html",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  java: "java",
  rb: "ruby",
  php: "php",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
};
/** The filetype OpenTUI highlights for `path`, or plain text. */
export const languageOf = (path: string) => LANGUAGES[path.split(".").at(-1) ?? ""] ?? "text";
