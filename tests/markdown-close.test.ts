import { expect, test } from "bun:test";
import { closeTail } from "../packages/airtty/src/markdown/close";

// [streamed so far, what is rendered]: after Streamdown's `remend` cases, for a terminal.
const CASES: readonly (readonly [string, string])[] = [
  // Emphasis closes from the first word.
  ["Text with **bold", "Text with **bold**"],
  ["**first** and **second", "**first** and **second**"],
  ["**bold text*", "**bold text**"],
  ["Text with *italic", "Text with *italic*"],
  ["**bold** and *italic", "**bold** and *italic*"],
  ["Text with __strong", "Text with __strong__"],
  ["Text with _italic", "Text with _italic_"],
  ["***both", "***both***"],
  ["**bold and *it", "**bold and *it***"],
  ["~~gone", "~~gone~~"],
  ["**bold ", "**bold** "],
  ["line one\n**bold", "line one\n**bold**"],
  // Complete text is left alone.
  ["**bold** and *italic* and `code`", "**bold** and *italic* and `code`"],
  ["plain text", "plain text"],
  // An opener with nothing after it yet is dropped, not closed.
  ["text **", "text "],
  ["text *", "text "],
  ["text `", "text "],
  ["text **\n", "text \n"],
  // Not emphasis: word-internal, arithmetic, bullets, escapes.
  ["snake_case_name", "snake_case_name"],
  ["hello*world", "hello*world"],
  ["2 * 3 * 4", "2 * 3 * 4"],
  ["20~25", "20~25"],
  ["* item", "* item"],
  ["* item with *it", "* item with *it*"],
  ["\\*not italic", "\\*not italic"],
  ["\\` *italic", "\\` *italic*"],
  // Code spans.
  ["Text with `code", "Text with `code`"],
  ["`code` **bold", "`code` **bold**"],
  ["`**bold`", "`**bold`"],
  ["`**not bold", "`**not bold`"],
  ["``a ` b", "``a ` b``"],
  // Links: the label alone until the link is complete.
  ["see [the docs", "see the docs"],
  ["see [the docs]", "see the docs"],
  ["see [the docs](https://exa", "see the docs"],
  ["see [**the docs**](https://exa", "see **the docs**"],
  ["see [the docs](https://example.com) now", "see [the docs](https://example.com) now"],
  ["an image ![alt](img", "an image alt"],
  ["at <https://exa", "at https://exa"],
  // Only the last inline context is closed.
  ["**open\n\nnext", "**open\n\nnext"],
  ["- **open\n- next *it", "- **open\n- next *it*"],
  ["# Title **bo", "# Title **bo**"],
  // An unterminated line of block syntax waits for its newline.
  ["para\n\n-", "para\n\n"],
  ["para\n\n- ", "para\n\n"],
  ["para\n\n12.", "para\n\n"],
  ["para\n\n##", "para\n\n"],
  ["para\n\n```ts", "para\n\n"],
  ["para\n\n--", "para\n\n"],
  ["para\n\n> ", "para\n\n"],
  ["para\n\n| a | b", "para\n\n"],
  ["para\n---", "para\n"],
  ["para\n\n- item", "para\n\n- item"],
  ["# Title", "# Title"],
  // Inside a fence nothing is closed.
  ["```\n**not bold", "```\n**not bold"],
  ["```\ncode\n```\n**bold", "```\ncode\n```\n**bold**"],
];

test.each(CASES)("closeTail(%j)", (streamed, rendered) => {
  expect(closeTail(streamed)).toBe(rendered);
});
