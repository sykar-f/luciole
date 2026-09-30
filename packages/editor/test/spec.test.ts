/**
 * The CommonMark spec's 652 examples: reading one and writing it back from scratch keeps
 * its meaning (marked's HTML), and the rewritten form is stable.
 */
import { expect, test } from "bun:test";
import examples from "./fixtures/commonmark-0.31.2.json";
import { meaning, rewrite } from "./spec-harness.ts";

type Example = { markdown: string; example: number; section: string };
const EXAMPLES: readonly Example[] = examples;

const failures = (check: (example: Example) => boolean) =>
  EXAMPLES.filter((example) => {
    try {
      return !check(example);
    } catch {
      return true;
    }
  });

test("every example keeps its meaning when written back from scratch", () => {
  const failed = failures((e) => meaning(rewrite(e.markdown)) === meaning(e.markdown));
  const report = failed.map((e) => `#${e.example} ${e.section}: ${JSON.stringify(e.markdown)}`);
  expect(report).toEqual([]);
});

test("the rewritten form is stable", () => {
  const failed = failures((e) => rewrite(rewrite(e.markdown)) === rewrite(e.markdown));
  expect(failed.map((e) => `#${e.example} ${e.section}`)).toEqual([]);
});

// GFM's extensions, which the CommonMark examples leave out.
const GFM = [
  "~~struck~~ and ~one~",
  "- [ ] open\n- [x] done\n  - [ ] nested",
  "| a | b |\n|---|:-:|\n| 1 | 2 |\n| 3 | 4 |",
  "> | a |\n> |---|\n> | 1 |",
  "www.example.com and https://example.com/path?q=1 and me@example.com",
  "a | b | c",
  "1. one\n2. two\n\n   para\n3. three",
  "- a\n\n  > quoted in an item",
  "<details>\n<summary>More</summary>\n\nHidden\n\n</details>",
  "Line one  \nLine two\\\nLine three",
  '[ref][] and ![img][ref]\n\n[ref]: https://example.com "Title"',
  "Footnote-like [^1] text\n\n[^1]: not a footnote in marked",
];

test("GFM's extensions keep their meaning and a stable form", () => {
  for (const markdown of GFM) {
    expect({ markdown, meaning: meaning(rewrite(markdown)) }).toEqual({
      markdown,
      meaning: meaning(markdown),
    });
    expect({ markdown, stable: rewrite(rewrite(markdown)) }).toEqual({
      markdown,
      stable: rewrite(markdown),
    });
  }
});
