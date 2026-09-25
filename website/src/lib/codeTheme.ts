import type { ThemeRegistration } from "shiki";

// Quiet syntax colours: teal and amber stay reserved for Client and Server.
export const night: ThemeRegistration = {
  name: "airtty-night",
  type: "dark",
  colors: { "editor.background": "#07101f", "editor.foreground": "#dfe6f2" },
  tokenColors: [
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: "#6a7fa3", fontStyle: "italic" },
    },
    {
      scope: ["keyword", "storage", "storage.type", "keyword.control"],
      settings: { foreground: "#a9b8ff" },
    },
    { scope: ["string", "string.quoted", "string.template"], settings: { foreground: "#c9d7a5" } },
    { scope: ["constant.numeric", "constant.language"], settings: { foreground: "#f2a8c8" } },
    {
      scope: ["entity.name.function", "support.function", "meta.function-call"],
      settings: { foreground: "#f0f4fb" },
    },
    {
      scope: ["entity.name.type", "support.type", "entity.name.tag", "support.class.component"],
      settings: { foreground: "#9fd0ff" },
    },
    { scope: ["entity.other.attribute-name"], settings: { foreground: "#b7c4dc" } },
    { scope: ["variable", "variable.other"], settings: { foreground: "#dfe6f2" } },
    { scope: ["punctuation", "meta.brace"], settings: { foreground: "#8a9bbb" } },
  ],
};
