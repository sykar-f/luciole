import type { ThemeRegistration } from "shiki";

// Syntax colours from the palette (styles/palettes.css): quiet, clear of the Client and
// Server accents. Shiki writes each token's colour as it is given, so a var() follows the
// preset in use without building the page again.
export const night: ThemeRegistration = {
  name: "luciole-palette",
  type: "dark",
  colors: { "editor.background": "var(--code-bg)", "editor.foreground": "var(--paper)" },
  tokenColors: [
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: "var(--code-comment)", fontStyle: "italic" },
    },
    {
      scope: ["keyword", "storage", "storage.type", "keyword.control"],
      settings: { foreground: "var(--code-keyword)" },
    },
    {
      scope: ["string", "string.quoted", "string.template"],
      settings: { foreground: "var(--code-string)" },
    },
    {
      scope: ["constant.numeric", "constant.language"],
      settings: { foreground: "var(--code-number)" },
    },
    {
      scope: ["entity.name.function", "support.function", "meta.function-call"],
      settings: { foreground: "var(--code-function)" },
    },
    {
      scope: ["entity.name.type", "support.type", "entity.name.tag", "support.class.component"],
      settings: { foreground: "var(--code-type)" },
    },
    { scope: ["entity.other.attribute-name"], settings: { foreground: "var(--code-attr)" } },
    { scope: ["variable", "variable.other"], settings: { foreground: "var(--paper)" } },
    { scope: ["punctuation", "meta.brace"], settings: { foreground: "var(--code-punct)" } },
  ],
};
