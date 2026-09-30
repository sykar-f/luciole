/** Code colored without Tree-sitter (diffs, SQL), and which group wins over the same text. */
import { expect, test } from "bun:test";
import { groupsByOffset, Highlighter } from "../src/view/highlight.ts";

const groups = (lang: string, text: string) => {
  const highlights = new Highlighter(() => {}).lookup(0, lang, text) ?? [];
  return highlights.map(([from, to, group]) => `${text.slice(from, to)}:${group}`);
};

test("a diff is colored line by line, at once", () => {
  expect(groups("diff", "@@ -1 +1 @@\n- before\n+ after\n  same")).toEqual([
    "@@ -1 +1 @@:diff.delta",
    "- before:diff.minus",
    "+ after:diff.plus",
  ]);
});

test("SQL is colored by its words: keywords, types, strings, numbers, calls, comments", () => {
  expect(
    groups("sql", "SELECT count(id), 'a''b' FROM t WHERE n > 10 -- note\nCAST(x AS integer)"),
  ).toEqual([
    "SELECT:keyword",
    "count:function.call",
    "'a''b':string",
    "FROM:keyword",
    "WHERE:keyword",
    ">:operator",
    "10:number",
    "-- note:comment",
    "CAST:function.call",
    "AS:keyword",
    "integer:type.builtin",
  ]);
});

test("over the same text, the more specific group wins, whatever the order it came in", () => {
  const byOffset = groupsByOffset(
    [
      [0, 3, "function.method"],
      [0, 3, "variable"],
    ],
    3,
  );
  expect(byOffset[0]).toEqual(["variable", "function.method"]);
});
