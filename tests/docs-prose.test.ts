import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type Finding,
  lintSource,
  ratchet,
  readAllowlist,
  run,
} from "../website/scripts/prose-lint.ts";

// The prose lint of website/STYLE.md. The docs must hold the ratchet of
// website/scripts/prose-allowlist.json; the other tests pin each rule on text quoted from
// the pages, so that a page rewrite does not take a rule's proof with it.
const root = resolve(import.meta.dir, "..");

const rulesOf = (source: string) =>
  lintSource("page.mdx", source).map(({ line, rule }) => `${line} ${rule}`);

describe("the docs and the README", () => {
  const { files, findings, errors } = run();

  test("hold the allowlist's ratchet", () => {
    expect(files).toContain("README.md");
    expect(files).toContain("website/src/content/docs/getting-started.mdx");
    expect(errors).toEqual([]);
  });

  test("fail when a page's count drops and its entry does not", () => {
    // The first listed page, as if a mission had fixed one finding and kept its entry.
    const [path, count] = Object.entries(readAllowlist())[0] ?? ["", 0];
    const found = findings.filter((finding) => finding.path === path).length;
    expect(found).toBe(count);
    expect(run([], { ...readAllowlist(), [path]: count + 1 }).errors).toEqual([
      `${path}: ${count} findings, lower its count from ${count + 1} to ${count}`,
    ]);
  });
});

describe("the ratchet", () => {
  const finding = (path: string): Finding => ({ path, line: 1, rule: "long-sentence", detail: "" });
  const checked = ["a.mdx", "b.mdx"];

  test("passes listed files at their count, and clean files off the list", () => {
    expect(ratchet([finding("a.mdx"), finding("a.mdx")], { "a.mdx": 2 }, checked)).toEqual([]);
  });

  test("refuses a listed file whose count drops: the entry follows it down", () => {
    expect(ratchet([finding("a.mdx")], { "a.mdx": 2 }, checked)).toEqual([
      "a.mdx: 1 findings, lower its count from 2 to 1",
    ]);
  });

  test("refuses a finding in a file that is not on the list", () => {
    expect(ratchet([finding("b.mdx")], { "a.mdx": 1 }, checked)).toContain(
      "b.mdx: 1 findings, and the file is not on the allowlist",
    );
  });

  test("refuses a listed file whose count grows", () => {
    expect(ratchet([finding("a.mdx"), finding("a.mdx")], { "a.mdx": 1 }, checked)).toEqual([
      "a.mdx: 2 findings, the allowlist allows 1",
    ]);
  });

  test("refuses a listed file with no finding left", () => {
    expect(ratchet([], { "a.mdx": 3 }, checked)).toEqual([
      "a.mdx: no finding left, remove it from the allowlist",
    ]);
  });

  test("refuses a listed file the lint does not read", () => {
    expect(ratchet([], { "gone.mdx": 1 }, checked)).toEqual([
      "gone.mdx: not a page the lint reads, remove it from the allowlist",
    ]);
  });
});

describe("split-paragraph", () => {
  // The three cases the reviews found, as the pages had them on 2026-10-04.
  test("reports a sentence cut before <kbd>, as in concepts/client-components", () => {
    const page = [
      "The framework declares only <kbd>Ctrl+C</kbd> (quit) and, during a navigation,",
      "",
      "<kbd>Esc</kbd> (cancel), in the `luciole` group.",
    ].join("\n");
    expect(rulesOf(page)).toEqual(["3 split-paragraph"]);
  });

  test("reports a sentence cut before <kbd>, as in guides/devtools", () => {
    const page = [
      "Common keys: <kbd>1</kbd>–<kbd>7</kbd> or <kbd>Tab</kbd> switch panels, <kbd>j</kbd> /",
      "",
      "<kbd>k</kbd> or the arrows select.",
    ].join("\n");
    expect(rulesOf(page)).toEqual(["3 split-paragraph"]);
  });

  test("reports a sentence cut before <code>, as in reference/cli", () => {
    const page = [
      "The package declares two commands. In a clone of the repository,",
      "",
      "<code>{commands.fromClone}</code> runs the same CLI without installing anything.",
    ].join("\n");
    expect(rulesOf(page)).toEqual(["3 split-paragraph"]);
  });

  test("reports lowercase text that goes on with a cut sentence", () => {
    expect(rulesOf("The Client draws the page with\n\nOpenTUI and the Server.")).toEqual([]);
    expect(rulesOf("The Client draws the page with\n\nthe help of OpenTUI.")).toEqual([
      "3 split-paragraph",
    ]);
  });

  test("lets a paragraph start lowercase or with a tag after a full sentence", () => {
    expect(rulesOf("The Server renders.\n\nluciole draws it.")).toEqual([]);
    expect(rulesOf("Keys of the list:\n\n<kbd>Enter</kbd> opens a note.")).toEqual([]);
    expect(rulesOf("## Keys\n\n<kbd>Enter</kbd> opens a note.")).toEqual([]);
  });
});

describe("lengths and clauses", () => {
  // A sentence starts with a capital: lowercase text after a full stop goes on with it.
  const sentence = (count: number) =>
    `Word${Array.from({ length: count - 1 }, () => " word").join("")}.`;

  test("a sentence over 30 words, a paragraph over 60", () => {
    expect(rulesOf(sentence(30))).toEqual([]);
    expect(rulesOf(sentence(31))).toEqual(["1 long-sentence"]);
    expect(rulesOf(`${sentence(30)} ${sentence(30)}`)).toEqual([]);
    expect(rulesOf(`${sentence(30)}\n${sentence(25)} ${sentence(6)}`)).toEqual([
      "1 long-paragraph",
    ]);
  });

  test("reports the line where the sentence starts", () => {
    expect(rulesOf(`Short one.\nThen ${sentence(31)}`)).toEqual(["2 long-sentence"]);
  });

  test("a code span, an expression and a link count as one word each", () => {
    const code = "`a b c d e f g h i j`";
    const words = `${code} [one two](https://luciole.sh/docs/x/) {a + b}`;
    expect(rulesOf(`${sentence(26).slice(0, -1)} ${words}.`)).toEqual([]);
    expect(rulesOf(`${sentence(27).slice(0, -1)} ${words}.`)).toEqual(["1 long-sentence"]);
  });

  test("two semicolons, or a semicolon and a colon, in one sentence", () => {
    // getting-started.mdx:54-56, before and after its rewrite.
    expect(
      rulesOf(
        "The route and named fields come back; state held only in memory does not: there is no Fast Refresh.",
      ),
    ).toEqual(["1 chained-clauses"]);
    expect(rulesOf("One; two; three.")).toEqual(["1 chained-clauses"]);
    expect(
      rulesOf(
        "The route and named fields come back. State held only in memory is lost: there is no Fast Refresh.",
      ),
    ).toEqual([]);
    expect(rulesOf("One clause; another.")).toEqual([]);
  });

  test("punctuation inside code, URLs and links does not count", () => {
    expect(rulesOf("Run `a; b; c: d` from https://luciole.sh/docs; then stop.")).toEqual([]);
  });

  test("a sentence may start with code, an expression or a component", () => {
    for (const start of ["`--app`", "{commands.cli}", '<Src path="a.ts" />'])
      expect(rulesOf(`${sentence(20)} ${start} ${sentence(20).toLowerCase()}`)).toEqual([]);
  });

  test("abbreviations do not end a sentence", () => {
    expect(rulesOf(`Some flags, e.g. ${sentence(27)}`)).toEqual([]);
    expect(rulesOf(`Some flags, e.g. ${sentence(28)}`)).toEqual(["1 long-sentence"]);
  });
});

describe("what is not prose", () => {
  test("front matter, imports, fences, tables, headings and component tags are skipped", () => {
    const long = Array.from({ length: 40 }, () => "word").join(" ");
    const page = [
      "---",
      `description: ${long}; one: two; three.`,
      "---",
      "",
      'import Note from "../Note.astro";',
      "import {",
      "  a,",
      '} from "x";',
      "",
      `## ${long}`,
      "",
      "```ts",
      `// ${long}; a; b: c`,
      "```",
      "",
      `| ${long}; a; b | c |`,
      "",
      "<Excerpt",
      `  path="${long}"`,
      "/>",
      "",
      '<p align="center">',
      `  <img alt="${long}" />`,
      "</p>",
    ].join("\n");
    expect(rulesOf(page)).toEqual([]);
  });

  test("the text inside a Note is prose", () => {
    const page = ['<Note kind="warning">', "  One; two; three.", "</Note>"].join("\n");
    expect(rulesOf(page)).toEqual(["2 chained-clauses"]);
  });

  test("each list item is a paragraph of its own", () => {
    const item = Array.from({ length: 40 }, () => "word").join(" ");
    const page = [`- ${item}.`, `- ${item}.`].join("\n");
    expect(rulesOf(page)).toEqual(["1 long-sentence", "2 long-sentence"]);
  });
});

describe("exceptions", () => {
  const long = `${Array.from({ length: 31 }, () => "word").join(" ")}.`;

  test("an allow comment on the line before silences one finding", () => {
    const page = `{/* prose-lint: allow long-sentence — a list of flags reads as one unit */}\n${long}`;
    expect(rulesOf(page)).toEqual([]);
    expect(rulesOf(`<!-- prose-lint: allow long-sentence — a table row -->\n${long}`)).toEqual([]);
  });

  test("an allow comment without a reason, or for an unknown rule, is a finding", () => {
    expect(rulesOf(`{/* prose-lint: allow long-sentence */}\n${long}`)).toEqual([
      "1 bad-allow",
      "2 long-sentence",
    ]);
    expect(rulesOf(`{/* prose-lint: allow wordy — because */}\nShort.`)).toEqual(["1 bad-allow"]);
  });

  test("an allow comment that silences nothing is a finding", () => {
    expect(rulesOf("{/* prose-lint: allow long-sentence — no longer */}\nShort.")).toEqual([
      "1 unused-allow",
    ]);
  });
});

test("the command prints path:line rule and fails off the allowlist", async () => {
  const directory = mkdtempSync(join(tmpdir(), "prose-lint-"));
  const page = join(directory, "page.mdx");
  writeFileSync(page, "One; two; three.\n");
  const child = Bun.spawn([process.execPath, "website/scripts/prose-lint.ts", page], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(out).toMatch(/^\S*page\.mdx:1 chained-clauses \(2 semicolons, 0 colons\)\n$/);
  expect(code).toBe(1);
});
