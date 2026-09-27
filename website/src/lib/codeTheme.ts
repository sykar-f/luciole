import type { ThemeRegistration } from "shiki";

// Quiet syntax colours on warm black: green and amber stay reserved for Client and Server.
export const night: ThemeRegistration = {
  name: "airtty-night",
  type: "dark",
  colors: { "editor.background": "#070604", "editor.foreground": "#e8e1cf" },
  tokenColors: [
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: "#8a8472", fontStyle: "italic" },
    },
    {
      scope: ["keyword", "storage", "storage.type", "keyword.control"],
      settings: { foreground: "#c7b8e8" },
    },
    { scope: ["string", "string.quoted", "string.template"], settings: { foreground: "#cfc39a" } },
    { scope: ["constant.numeric", "constant.language"], settings: { foreground: "#e6a6a0" } },
    {
      scope: ["entity.name.function", "support.function", "meta.function-call"],
      settings: { foreground: "#f4eedf" },
    },
    {
      scope: ["entity.name.type", "support.type", "entity.name.tag", "support.class.component"],
      settings: { foreground: "#a9c4d6" },
    },
    { scope: ["entity.other.attribute-name"], settings: { foreground: "#c2b9a3" } },
    { scope: ["variable", "variable.other"], settings: { foreground: "#e8e1cf" } },
    { scope: ["punctuation", "meta.brace"], settings: { foreground: "#9b9480" } },
  ],
};
