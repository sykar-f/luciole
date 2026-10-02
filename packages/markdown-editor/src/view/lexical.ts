import type { SimpleHighlight } from "@opentui/core";

// Languages colored without Tree-sitter, synchronously: a diff by its lines (no grammar
// reads one better than its first characters), SQL by its words (no Tree-sitter grammar
// for it ships its WebAssembly). The groups are the ones Tree-sitter grammars emit, so a
// style colors them alike.

type Lexer = (text: string) => SimpleHighlight[];

const DIFF: Lexer = (text) => {
  const out: SimpleHighlight[] = [];
  let at = 0;
  for (const line of text.split("\n")) {
    const group = /^(diff |index |\+\+\+ |--- )/.test(line)
      ? "diff.header"
      : line.startsWith("@@")
        ? "diff.delta"
        : line.startsWith("+")
          ? "diff.plus"
          : line.startsWith("-")
            ? "diff.minus"
            : undefined;
    if (group && line) out.push([at, at + line.length, group]);
    at += line.length + 1;
  }
  return out;
};

const SQL_KEYWORDS = new Set(
  `select from where and or not in is null as on join left right inner outer full cross
  group by order having limit offset insert into values update set delete create table
  view index drop alter add column primary key foreign references unique default
  distinct union all case when then else end exists between like ilike asc desc with
  returning if begin commit rollback transaction explain`
    .split(/\s+/)
    .filter(Boolean),
);
const SQL_TYPES = new Set(
  "int integer bigint smallint real float double numeric decimal text varchar char boolean bool date time timestamp blob json jsonb uuid serial".split(
    " ",
  ),
);
const SQL_CONSTANTS = new Set(["true", "false", "null"]);
// A comment, a string, a quoted name, a number, a word, an operator: in that order.
const SQL_TOKEN =
  /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^']|'')*'?)|("(?:[^"]|"")*"?|`[^`]*`?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][\w$]*)(\s*\()?|([<>=!]=?|<>|\|\||[-+*/%])/g;

const SQL: Lexer = (text) => {
  const out: SimpleHighlight[] = [];
  for (const match of text.matchAll(SQL_TOKEN)) {
    const [whole, comment, string, quoted, number, word, call, operator] = match;
    const start = match.index;
    const span = (length: number, group: string) => out.push([start, start + length, group]);
    if (comment) span(whole.length, "comment");
    else if (string) span(string.length, "string");
    else if (quoted) span(quoted.length, "variable.member");
    else if (number) span(number.length, "number");
    else if (operator) span(operator.length, "operator");
    else if (word) {
      const lower = word.toLowerCase();
      if (SQL_CONSTANTS.has(lower)) span(word.length, "constant.builtin");
      else if (SQL_KEYWORDS.has(lower)) span(word.length, "keyword");
      else if (SQL_TYPES.has(lower)) span(word.length, "type.builtin");
      else if (call) span(word.length, "function.call");
    }
  }
  return out;
};

const LEXERS: Readonly<Record<string, Lexer>> = {
  diff: DIFF,
  patch: DIFF,
  udiff: DIFF,
  sql: SQL,
  sqlite: SQL,
  postgres: SQL,
  postgresql: SQL,
  mysql: SQL,
};

/** A lexer for `lang` (an info string's first word), when it has one here. */
export const lexerFor = (lang: string): Lexer | undefined => LEXERS[lang.toLowerCase()];
