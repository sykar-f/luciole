/**
 * The layers under the view: Markdown read and written back, the layout and the cursor
 * mapped through it, the controller, the keys.
 */
import { expect, test } from "bun:test";
import { SyntaxStyle } from "@opentui/core";
import { EditorController } from "../src/editing/controller.ts";
import { parseMarkdown } from "../src/markdown/parse.ts";
import { serializeMarkdown } from "../src/markdown/serialize.ts";
import { cellOf, layoutDocument, posAt } from "../src/view/layout.ts";
import { moveVertical } from "../src/view/motion.ts";
import { intentOf } from "../src/view/keys.ts";
import { Theme } from "../src/view/theme.ts";

const theme = new Theme(SyntaxStyle.fromStyles({}));

test("an untouched document is written back exactly as it was read", () => {
  const markdown =
    "Setext title\n===\n\nA *para*   with  spaces\n\n~~~\nfenced\n~~~\n\n| a |\n|---|\n| 1 |";
  expect(serializeMarkdown(parseMarkdown(markdown))).toBe(markdown);
});

test("an edit rewrites only the block it touched", () => {
  const editor = new EditorController("A  __strong__ one\n\nSecond *para*");
  editor.moveTo({ block: 1, offset: 6 });
  editor.type("!");
  expect(editor.markdown).toBe("A  __strong__ one\n\nSecond! *para*");
});

test("what the editor does not model is kept as written", () => {
  const markdown = "<details>\n<summary>More</summary>\n</details>\n\nSee ![logo](logo.png) here";
  const doc = parseMarkdown(markdown);
  expect(doc[0]?.type).toBe("raw");
  expect(serializeMarkdown(doc.map((block) => ({ ...block, source: undefined })))).toBe(markdown);
});

test("delimiters are always balanced, spaces kept outside them", () => {
  const editor = new EditorController("hello world");
  editor.select({ anchor: { block: 0, offset: 5 }, head: { block: 0, offset: 11 } });
  editor.toggleMark("bold");
  expect(editor.markdown).toBe("hello **world**");
  editor.select({ anchor: { block: 0, offset: 3 }, head: { block: 0, offset: 8 } });
  editor.toggleMark("italic");
  expect(editor.markdown).toBe("hel*lo* ***wo*rld**");
  expect(parseMarkdown(editor.markdown)[0]).toMatchObject({
    content: [
      { text: "hel", marks: {} },
      { text: "lo", marks: { italic: true } },
      { text: " ", marks: {} },
      { text: "wo", marks: { bold: true, italic: true } },
      { text: "rld", marks: { bold: true } },
    ],
  });
});

test("undo takes back a burst of typing at once, redo brings it back", () => {
  const editor = new EditorController("");
  editor.type("h");
  editor.type("i");
  editor.enter();
  editor.type("x");
  expect(editor.markdown).toBe("hi\n\nx");
  editor.undo();
  // An empty paragraph writes nothing, but it is there.
  expect(editor.state.doc.length).toBe(2);
  editor.undo();
  expect(editor.state.doc.length).toBe(1);
  expect(editor.markdown).toBe("hi");
  editor.undo();
  expect(editor.markdown).toBe("");
  editor.redo();
  expect(editor.markdown).toBe("hi");
});

test("pasted Markdown lands as blocks, its first line joining the current one", () => {
  const editor = new EditorController("Start: ");
  editor.end();
  editor.paste("**bold** text\n\n- one\n- two");
  expect(editor.markdown).toBe("Start: **bold** text\n\n- one\n- two");
  const inline = new EditorController("ab");
  inline.moveTo({ block: 0, offset: 1 });
  inline.paste("*x*");
  expect(inline.markdown).toBe("a*x*b");
});

test("a selection copies as Markdown", () => {
  const editor = new EditorController("# Title\n\nsome **bold** words");
  editor.select({ anchor: { block: 0, offset: 2 }, head: { block: 1, offset: 9 } });
  expect(editor.selectedMarkdown()).toBe("# tle\n\nsome **bold**");
});

test("text wraps at words; cursor and clicks map through the lines", () => {
  const layout = layoutDocument(parseMarkdown("one two three four"), 9, theme);
  expect(layout.lines.map((line) => line.glyphs.map((g) => g.text).join(""))).toEqual([
    "one two ",
    "three ",
    "four",
  ]);
  // The start of "three" is drawn at the start of the second line, not after "two ".
  expect(cellOf(layout, { block: 0, offset: 8 })).toEqual({ row: 1, col: 0 });
  expect(posAt(layout, 2, 2)).toEqual({ block: 0, offset: 16 });
  // Down keeps the column.
  expect(moveVertical(layout, { block: 0, offset: 2 }, 1, null).pos).toEqual({
    block: 0,
    offset: 10,
  });
});

test("markers take their room: list text starts after the bullet, a blank line between blocks", () => {
  const layout = layoutDocument(parseMarkdown("para\n\n- item\n  - nested"), 30, theme);
  expect(layout.lines.map((line) => line.block)).toEqual([0, -1, 1, 2]);
  expect(layout.lines[2]?.marker?.text).toBe("•");
  expect(cellOf(layout, { block: 2, offset: 0 })).toEqual({ row: 3, col: 4 });
});

test("keys read as intents", () => {
  const key = (name: string, extra: Partial<Parameters<typeof intentOf>[0]> = {}) =>
    intentOf({
      name,
      sequence: name.length === 1 ? name : "",
      ctrl: false,
      meta: false,
      shift: false,
      ...extra,
    });
  expect(key("a")).toEqual({ type: "type", text: "a" });
  expect(key("return")).toEqual({ type: "enter" });
  expect(key("return", { shift: true })).toEqual({ type: "lineBreak" });
  expect(key("left", { shift: true })).toMatchObject({ type: "move", to: "left", extend: true });
  expect(key("left", { meta: true })).toMatchObject({ type: "move", to: "left", word: true });
  expect(key("z", { ctrl: true })).toEqual({ type: "undo" });
  expect(key("z", { ctrl: true, shift: true })).toEqual({ type: "redo" });
  expect(key("b", { super: true })).toEqual({ type: "mark", mark: "bold" });
  expect(key("escape", { sequence: "\u001b" })).toBeNull();
});
