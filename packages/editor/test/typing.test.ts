/**
 * Markdown typed key by key, through the path a terminal's keys take: bytes parsed by
 * OpenTUI, read as intents, carried out on the controller. Every scenario runs on three
 * keyboards, and must give the same Markdown and the same screen on each:
 *
 * - legacy: what xterm sends;
 * - kitty-all: the kitty protocol with every key as an escape and its text (shifted keys
 *   arrive as their base key, `8` with Shift for `*`);
 * - mac-alt: a French Mac, where `[ ] { } | ~ \` are typed with Option (Alt).
 */
import { describe, expect, test } from "bun:test";
import { parseKeypress, RGBA, SyntaxStyle } from "@opentui/core";
import { EditorController } from "../src/editing/controller.ts";
import { intentOf, perform } from "../src/view/keys.ts";
import { layoutDocument } from "../src/view/layout.ts";
import { Theme } from "../src/view/theme.ts";

type Keyboard = (char: string) => string;
const ESC = "\u001b";
// US layout: the key a shifted symbol is on.
const SHIFTED: Readonly<Record<string, string>> = {
  "!": "1",
  "@": "2",
  "#": "3",
  $: "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
  _: "-",
  "+": "=",
  "{": "[",
  "}": "]",
  "|": "\\",
  ":": ";",
  '"': "'",
  "<": ",",
  ">": ".",
  "?": "/",
  "~": "`",
};
const code = (char: string) => char.codePointAt(0) ?? 0;
const keyboards: Record<string, Keyboard> = {
  legacy: (char) => char,
  "kitty-all": (char) => {
    const base = SHIFTED[char] ?? (/[A-Z]/.test(char) ? char.toLowerCase() : undefined);
    if (base !== undefined) return `${ESC}[${code(base)}:${code(char)};2;${code(char)}u`;
    return `${ESC}[${code(char)};1;${code(char)}u`;
  },
  "mac-alt": (char) => ("[]{}|~\\".includes(char) ? `${ESC}[${code(char)};3u` : char),
};
const SPECIAL: Readonly<Record<string, string>> = {
  enter: "\r",
  "shift+enter": `${ESC}[13;2u`,
  bs: "\u007f",
  tab: "\t",
  "shift+tab": `${ESC}[Z`,
};

/** Keys as a script: text is typed, `{enter}`, `{bs}`, `{tab}`… are those keys. */
function run(script: string, keyboard: Keyboard, initial = "") {
  const editor = new EditorController(initial);
  editor.end();
  for (const part of script.split(/(\{[a-z+]+\})/)) {
    const special = /^\{([a-z+]+)\}$/.exec(part)?.[1];
    const sequences =
      special !== undefined ? [SPECIAL[special] ?? ""] : Array.from(part, (char) => keyboard(char));
    for (const sequence of sequences) {
      const key = parseKeypress(sequence, { useKittyKeyboard: true });
      const intent = key ? intentOf(key) : null;
      if (!intent) throw new Error(`No intent for ${JSON.stringify(sequence)}`);
      if (intent.type === "move") throw new Error("Moves need a screen");
      perform(editor, intent, { copy: () => {} });
    }
  }
  return editor;
}

const band = { bg: RGBA.fromHex("#3a3020") };
const theme = new Theme(
  SyntaxStyle.fromStyles({
    "markup.heading.1": band,
    "markup.heading.2": band,
    "markup.heading.3": band,
  }),
);
/** What the screen shows, line by line: markers and text, no trailing spaces. */
function screen(editor: EditorController) {
  const layout = layoutDocument(editor.state.doc, 60, theme);
  return layout.lines
    .filter((line) => !line.pad)
    .map((line) => {
      const cells: string[] = [];
      const put = (x: number, text: string) => {
        Array.from(text).forEach((char, i) => (cells[x + i] = char));
      };
      for (let bar = 0; bar < line.bars; bar++) put(bar * 2, "│");
      if (line.rule) put(line.x, "───");
      if (line.marker) put(line.marker.x, line.marker.text);
      for (const glyph of line.glyphs) put(glyph.x, glyph.text);
      return Array.from(cells, (cell) => cell ?? " ")
        .join("")
        .trimEnd();
    })
    .join("\n");
}

type Case = { keys: string; markdown: string; screen?: string; initial?: string };
const cases: Record<string, Case[]> = {
  "emphasis opens before a word and closes after one": [
    { keys: "**bold** after", markdown: "**bold** after", screen: "bold after" },
    { keys: "**bold**", markdown: "**bold**", screen: "bold" },
    { keys: "*it* after", markdown: "*it* after", screen: "it after" },
    { keys: "*it*", markdown: "*it*", screen: "it" },
    { keys: "_it_ after", markdown: "*it* after", screen: "it after" },
    { keys: "__bold__ after", markdown: "**bold** after", screen: "bold after" },
    { keys: "***both*** after", markdown: "***both*** after", screen: "both after" },
    { keys: "~~gone~~ after", markdown: "~~gone~~ after", screen: "gone after" },
    { keys: "`code` after", markdown: "`code` after", screen: "code after" },
    { keys: "`code`", markdown: "`code`", screen: "code" },
    { keys: "**bold *both* bold** plain", markdown: "**bold *both* bold** plain" },
    { keys: "a*b*c", markdown: "a*b*c", screen: "abc" },
  ],
  "what is opened closes by itself": [
    { keys: "**bold{enter}next", markdown: "**bold**\n\nnext", screen: "bold\n\nnext" },
    { keys: "a `code", markdown: "a `code`", screen: "a code" },
  ],
  "delimiters stay characters where they mean nothing": [
    { keys: "2 * 3 * 4", markdown: "2 \\* 3 \\* 4", screen: "2 * 3 * 4" },
    { keys: "snake_case_name", markdown: "snake\\_case\\_name", screen: "snake_case_name" },
    { keys: "a ~ b", markdown: "a \\~ b", screen: "a ~ b" },
    { keys: "`*no*`", markdown: "`*no*`", screen: "*no*" },
  ],
  "a backslash makes punctuation itself": [
    { keys: "\\*literal\\*", markdown: "\\*literal\\*", screen: "*literal*" },
    { keys: "\\# not a title", markdown: "\\# not a title", screen: "# not a title" },
    { keys: "\\- not a list", markdown: "\\- not a list", screen: "- not a list" },
    { keys: "\\[not](a link)", markdown: "\\[not\\](a link)", screen: "[not](a link)" },
    { keys: "\\\\", markdown: "\\\\", screen: "\\" },
  ],
  headings: [
    { keys: "# One", markdown: "# One", screen: "  One" },
    { keys: "## Two", markdown: "## Two", screen: "  Two" },
    { keys: "### Three", markdown: "### Three", screen: "  Three" },
    { keys: "###### Six", markdown: "###### Six", screen: "SIX" },
    { keys: "####### seven", markdown: "####### seven", screen: "####### seven" },
    { keys: "#### Four", markdown: "#### Four", screen: "▎ Four" },
    { keys: "#no space", markdown: "#no space", screen: "#no space" },
    { keys: "# Title{enter}text", markdown: "# Title\n\ntext" },
  ],
  lists: [
    { keys: "- one{enter}two", markdown: "- one\n- two", screen: "• one\n• two" },
    { keys: "* one", markdown: "- one", screen: "• one" },
    { keys: "+ one", markdown: "- one", screen: "• one" },
    { keys: "- one{enter}{enter}after", markdown: "- one\n\nafter", screen: "• one\n\nafter" },
    { keys: "1. a{enter}b{enter}c", markdown: "1. a\n2. b\n3. c", screen: "1. a\n2. b\n3. c" },
    { keys: "3. x{enter}y", markdown: "3. x\n4. y", screen: "3. x\n4. y" },
    { keys: "1) x{enter}y", markdown: "1) x\n2) y" },
    { keys: "- a{enter}{tab}b", markdown: "- a\n  - b", screen: "• a\n  ◦ b" },
    { keys: "- a{enter}{tab}b{enter}{shift+tab}c", markdown: "- a\n  - b\n- c" },
    { keys: "- a{enter}{tab}b{enter}{enter}c", markdown: "- a\n  - b\n- c" },
    { keys: "- ", markdown: "-", screen: "•" },
  ],
  tasks: [
    { keys: "- [ ] todo", markdown: "- [ ] todo", screen: "[ ] todo" },
    { keys: "- [x] done", markdown: "- [x] done", screen: "[✓] done" },
    {
      keys: "[ ] todo{enter}next",
      markdown: "- [ ] todo\n- [ ] next",
      screen: "[ ] todo\n[ ] next",
    },
    { keys: "[x] done", markdown: "- [x] done", screen: "[✓] done" },
  ],
  quotes: [
    { keys: "> quoted", markdown: "> quoted", screen: "│ quoted" },
    { keys: "> a{enter}b", markdown: "> a\n>\n> b", screen: "│ a\n│\n│ b" },
    { keys: "> a{enter}{enter}out", markdown: "> a\n\nout", screen: "│ a\n\nout" },
    { keys: "> > deep", markdown: "> > deep", screen: "│ │ deep" },
    { keys: "> - item{enter}next", markdown: "> - item\n> - next", screen: "│ • item\n│ • next" },
    { keys: "> # Title", markdown: "> # Title" },
  ],
  "code blocks": [
    {
      keys: "```ts{enter}const a = 1;",
      markdown: "```ts\nconst a = 1;\n```",
      screen: "  const a = 1;",
    },
    { keys: "```{enter}x{enter}{enter}after", markdown: "```\nx\n```\n\nafter" },
    { keys: "~~~{enter}x", markdown: "```\nx\n```" },
    { keys: "```{enter}a{enter}{enter}{enter}b", markdown: "```\na\n```\n\nb" },
    { keys: "```{enter}**not bold**", markdown: "```\n**not bold**\n```" },
  ],
  rules: [
    { keys: "---{enter}after", markdown: "---\n\nafter", screen: "───\n\nafter" },
    { keys: "***{enter}after", markdown: "---\n\nafter" },
    { keys: "___{enter}after", markdown: "---\n\nafter" },
  ],
  links: [
    {
      keys: "see [site](https://x.y) now",
      markdown: "see [site](https://x.y) now",
      screen: "see site now",
    },
    { keys: "[**bold** site](u)", markdown: "[**bold** site](u)", screen: "bold site" },
    { keys: "see https://x.y now", markdown: "see [https://x.y](https://x.y) now" },
    { keys: "<https://x.y>", markdown: "[https://x.y](https://x.y)", screen: "https://x.y" },
    { keys: "<me@x.y>", markdown: "[me@x.y](mailto:me@x.y)", screen: "me@x.y" },
    { keys: "![alt](pic.png)", markdown: "![alt](pic.png)" },
  ],
  "line breaks": [{ keys: "a{shift+enter}b", markdown: "a\nb", screen: "a\nb" }],
  "character references": [
    { keys: "&copy; 2026", markdown: "© 2026", screen: "© 2026" },
    { keys: "AT&T", markdown: "AT&T", screen: "AT&T" },
    { keys: "&nothing;", markdown: "\\&nothing;", screen: "&nothing;" },
  ],
  tables: [
    {
      keys: "| a | b |{enter}|---|---|{enter}| 1 | 2 |",
      markdown: "| a | b |\n|---|---|\n| 1 | 2 |",
    },
  ],
  "Backspace right after a rule takes it back": [
    { keys: "# {bs}x", markdown: "\\# x" },
    { keys: "**b{bs}", markdown: "\\*\\*b" },
    // The closing star comes back as a character, still in italic; the next Backspace
    // removes it and italic is open again.
    { keys: "*it*{bs}", markdown: "*it\\**", screen: "it*" },
    { keys: "*it*{bs}{bs}more", markdown: "*itmore*" },
    { keys: "- {bs}", markdown: "\\-" },
    { keys: "- item{enter}{bs}", markdown: "- item" },
    { keys: "> {bs}", markdown: "\\>" },
  ],
};

for (const [name, keyboard] of Object.entries(keyboards))
  describe(`typed on ${name}`, () => {
    for (const [topic, list] of Object.entries(cases))
      test(topic, () => {
        for (const each of list) {
          const editor = run(each.keys, keyboard, each.initial);
          expect({ keys: each.keys, markdown: editor.markdown }).toEqual({
            keys: each.keys,
            markdown: each.markdown,
          });
          if (each.screen !== undefined)
            expect({ keys: each.keys, screen: screen(editor) }).toEqual({
              keys: each.keys,
              screen: each.screen,
            });
        }
      });
  });
