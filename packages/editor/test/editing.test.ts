import { expect, test } from "bun:test";
import { EMPTY_DOC } from "../src/model/doc.ts";
import { parseMarkdown } from "../src/markdown/parse.ts";
import { serializeMarkdown } from "../src/markdown/serialize.ts";
import { backspace, enter, toMarkdown, typeText } from "../src/editing/rules.ts";
import { createState, type EditorState } from "../src/editing/state.ts";
import { moveTo, selectAll } from "../src/editing/commands.ts";

/** Keys as a script: text is typed, ⏎ is Return, ⌫ is Backspace. */
function keys(script: string, state: EditorState = createState(EMPTY_DOC)) {
  let next = state;
  for (const part of script.split(/([⏎⌫])/u)) {
    if (part === "⏎") next = enter(next);
    else if (part === "⌫") next = backspace(next);
    else if (part) next = typeText(next, part);
  }
  return next;
}
const md = toMarkdown;
const typed = (script: string) => md(keys(script));

test("delimiters open before a word and close after one", () => {
  expect(typed("**bold** done")).toBe("**bold** done");
  expect(typed("an *easy* one")).toBe("an *easy* one");
  expect(typed("run `ls -la` now")).toBe("run `ls -la` now");
  expect(typed("~~gone~~ now")).toBe("~~gone~~ now");
  expect(typed("***both*** here")).toBe("***both*** here");
});

test("what is opened closes by itself at the end of the block", () => {
  expect(typed("**bold⏎next")).toBe("**bold**\n\nnext");
  expect(typed("a `code")).toBe("a `code`");
});

test("delimiters stay characters where they mean nothing", () => {
  expect(typed("a * b")).toBe("a \\* b");
  expect(typed("snake_case_name")).toBe("snake\\_case\\_name");
  expect(typed("\\*literal")).toBe("\\*literal");
  expect(typed("`*not italic*`")).toBe("`*not italic*`");
});

test("block markers become blocks", () => {
  expect(typed("# Title")).toBe("# Title");
  expect(typed("### Small")).toBe("### Small");
  expect(typed("- one⏎two⏎⏎after")).toBe("- one\n- two\n\nafter");
  expect(typed("1. a⏎b")).toBe("1. a\n2. b");
  expect(typed("- [ ] task⏎next")).toBe("- [ ] task\n- [ ] next");
  expect(typed("[x] done")).toBe("- [x] done");
  expect(typed("> quoted")).toBe("> quoted");
  expect(typed("```ts⏎const a = 1")).toBe("```ts\nconst a = 1\n```");
  expect(typed("```⏎x⏎⏎after")).toBe("```\nx\n```\n\nafter");
  expect(typed("---⏎after")).toBe("---\n\nafter");
});

test("links from their Markdown, and from a URL ended by a space", () => {
  expect(typed("see [site](https://x.y) now")).toBe("see [site](https://x.y) now");
  expect(typed("see https://x.y now")).toBe("see <https://x.y> now");
});

test("Backspace right after a rule takes it back", () => {
  expect(typed("# ⌫x")).toBe("\\# x");
  expect(typed("**b⌫")).toBe("\\*\\*b");
  expect(typed("- ⌫")).toBe("\\-");
  expect(typed("- item⏎⌫")).toBe("- item");
});

test("Backspace at the start of a marked block removes its mark", () => {
  const state = keys("## Title");
  const start = moveTo(state, { block: 0, offset: 0 });
  expect(md(backspace(start))).toBe("Title");
});

test("delimiters typed over a selection wrap it", () => {
  const state = selectAll(createState(parseMarkdown("hello")));
  expect(md(typeText(state, "**"))).toBe("**hello**");
  expect(md(typeText(state, "*"))).toBe("*hello*");
  expect(md(typeText(state, "`"))).toBe("`hello`");
});

test("nested lists keep their levels", () => {
  const doc = parseMarkdown("- a\n  - b\n    - c\n- d");
  expect(serializeMarkdown(doc.map((b) => ({ ...b })))).toBe("- a\n  - b\n    - c\n- d");
});

test("Backspace between text and a table or code crosses, it never joins them", () => {
  const table = "| a | b |\n| - | - |\n| 1 | 2 |";
  // At the start of a paragraph under a table: the cursor goes to the table's end.
  const under = moveTo(createState(parseMarkdown(`${table}\n\nafter`)), { block: 1, offset: 0 });
  const crossed = backspace(under);
  expect(md(crossed)).toBe(`${table}\n\nafter`);
  expect(crossed.selection.head).toEqual({ block: 0, offset: table.length });
  // At the start of code under a paragraph: the same, the code stays code.
  const code = moveTo(createState(parseMarkdown("text\n\n```\ncode\n```")), {
    block: 1,
    offset: 0,
  });
  expect(md(backspace(code))).toBe("text\n\n```\ncode\n```");
  // An empty paragraph between them simply goes.
  const empty = moveTo(createState([...parseMarkdown(table), { type: "paragraph", content: [] }]), {
    block: 1,
    offset: 0,
  });
  expect(backspace(empty).doc).toHaveLength(1);
});
