/**
 * What the editor draws, cell by cell: OpenTUI renders it, the test reads characters and
 * colors back. The heading bands are the ones luciole's <Markdown> draws.
 */
import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { RGBA, SyntaxStyle } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { MarkdownEditor } from "../src/index.ts";

const BAND = RGBA.fromHex("#3a3020");
const QUIET = RGBA.fromHex("#21262d");
const PANEL = RGBA.fromHex("#161b22");
const TERMINAL = RGBA.fromHex("#0d1117");
const style = SyntaxStyle.fromStyles({
  default: { fg: RGBA.fromHex("#e6edf3") },
  conceal: { fg: RGBA.fromHex("#4a5561") },
  "markup.heading": { fg: RGBA.fromHex("#e8b84a"), bold: true },
  "markup.heading.1": { fg: RGBA.fromHex("#fbe7b5"), bg: BAND, bold: true },
  "markup.heading.2": { fg: RGBA.fromHex("#fbe7b5"), bg: BAND, bold: true },
  "markup.heading.3": { fg: RGBA.fromHex("#e8b84a"), bg: QUIET, bold: true },
  "markup.strong": { bold: true },
  "markup.raw": { fg: RGBA.fromHex("#a5d6ff") },
  "markup.raw.block": { bg: PANEL },
  "markup.list": { fg: RGBA.fromHex("#e8b84a") },
  keyword: { fg: RGBA.fromHex("#ff7b72") },
});
const WIDTH = 60;

let ui: Awaited<ReturnType<typeof testRender>> | undefined;
afterEach(() => {
  ui?.renderer.destroy();
  ui = undefined;
});

function Harness({ initial, log = [] }: { initial: string; log?: string[] }) {
  const [value, setValue] = useState(initial);
  return (
    <box width={WIDTH} height={30}>
      <MarkdownEditor
        value={value}
        onChange={(markdown) => {
          log.push(markdown);
          setValue(markdown);
        }}
        syntaxStyle={style}
        terminalBackground={TERMINAL}
        focused
        flexGrow={1}
      />
    </box>
  );
}
async function show(markdown: string, log?: string[]) {
  ui = await testRender(<Harness initial={markdown} log={log} />, { width: WIDTH, height: 30 });
  await ui.renderOnce();
  return ui;
}

type Cell = { char: string; fg: RGBA; bg: RGBA };
function cell(x: number, y: number): Cell {
  const line = ui?.captureSpans().lines[y];
  let col = 0;
  for (const span of line?.spans ?? []) {
    if (x < col + span.width)
      return { char: Array.from(span.text)[x - col] ?? " ", fg: span.fg, bg: span.bg };
    col += span.width;
  }
  throw new Error(`No cell at ${x},${y}`);
}
const rows = () =>
  ui
    ?.captureCharFrame()
    .split("\n")
    .map((row) => row.trimEnd()) ?? [];
const same = (a: RGBA, b: RGBA) => a.toInts().join() === b.toInts().join();
/** How far `color` is from `to`, over the three channels. */
const distance = (color: RGBA, to: RGBA) =>
  color
    .toInts()
    .slice(0, 3)
    .reduce((sum, c, i) => sum + Math.abs(c - (to.toInts()[i] ?? 0)), 0);

test("an H1 is three rows on its band, full up to column 28, fading out to the edge", async () => {
  await show("# Title");
  const frame = rows();
  expect(frame[0]).toBe("");
  expect(frame[1]).toBe("  Title");
  expect(frame[2]).toBe("");
  for (const y of [0, 1, 2]) {
    // Full under the first 28 columns, the title's included (the title has no background
    // of its own: the band shows through).
    for (const x of [0, 2, 6, 27]) expect(same(cell(x, y).bg, BAND)).toBe(true);
    // Then fading into the terminal's background, column after column.
    let last = distance(cell(27, y).bg, TERMINAL);
    for (let x = 28; x < 57; x++) {
      const now = distance(cell(x, y).bg, TERMINAL);
      expect(now).toBeLessThan(last);
      last = now;
    }
    // Painted almost to the edge; the last columns are the terminal's own.
    expect(same(cell(57, y).bg, TERMINAL)).toBe(false);
    expect(same(cell(59, y).bg, BAND)).toBe(false);
  }
  expect(same(cell(2, 1).fg, RGBA.fromHex("#fbe7b5"))).toBe(true);
  expect(same(cell(0, 3).bg, BAND)).toBe(false);
});

test("an H2 is one row, full up to column 18; an H3 on the quiet band up to 12; deeper as H3", async () => {
  await show("## Two\n\n### Three\n\n#### Four");
  const frame = rows();
  expect(frame.slice(0, 5)).toEqual(["  Two", "", "  Three", "", "  Four"]);
  // Exactly the band up to its column, clearly fading a little further.
  expect(same(cell(17, 0).bg, BAND)).toBe(true);
  expect(distance(cell(30, 0).bg, BAND)).toBeGreaterThan(distance(cell(17, 0).bg, BAND));
  expect(same(cell(11, 2).bg, QUIET)).toBe(true);
  expect(distance(cell(30, 2).bg, QUIET)).toBeGreaterThan(0);
  expect(same(cell(11, 4).bg, QUIET)).toBe(true);
  // Nothing between the bands: the gaps are the terminal's.
  expect(same(cell(0, 1).bg, BAND) || same(cell(0, 1).bg, QUIET)).toBe(false);
});

test("headings keep the reader's rhythm: two lines above an H1, none under an H3", async () => {
  await show("para\n\n# One\n\ntext\n\n### Three\nunder\n\n## Two after three");
  expect(rows().slice(0, 12)).toEqual([
    "para",
    "",
    "",
    "",
    "  One",
    "",
    "",
    "text",
    "",
    "  Three",
    "under",
    "",
  ]);
  // An H2 that ends an H3's section stands two lines apart.
  expect(rows()[13]).toBe("  Two after three");
});

test("the document shows as it reads: no Markdown marker on screen", async () => {
  await show(
    [
      "Some **bold**, *italic*, ~~gone~~, `code` and a [link](https://x.y).",
      "",
      "- [ ] a task",
      "- [x] done",
      "- plain",
      "  - nested",
      "",
      "1. first",
      "2. second",
      "",
      "> quoted",
      "> > deeper",
      "",
      "> - listed in a quote",
      "",
      "---",
    ].join("\n"),
  );
  const text = rows().join("\n");
  for (const marker of ["**", "`", "~~", "](", "- [", "> ", "---"])
    expect(text).not.toContain(marker);
  expect(rows()).toContain("Some bold, italic, gone, code and a link.");
  expect(rows()).toContain("☐ a task");
  expect(rows()).toContain("☑ done");
  expect(rows()).toContain("  ◦ nested");
  expect(rows()).toContain("2. second");
  expect(rows()).toContain("│ quoted");
  expect(rows()).toContain("│ │ deeper");
  expect(rows()).toContain("│ • listed in a quote");
  expect(rows().at(-1) ?? rows().findLast((row) => row)).toBeDefined();
  expect(rows().some((row) => row.startsWith("─".repeat(WIDTH)))).toBe(true);
});

test("what an item holds lines up with its text", async () => {
  await show("1. first\n\n   more of it\n\n   ```\n   code\n   ```\n2. second");
  const frame = rows();
  expect(frame.slice(0, 8)).toEqual([
    "1. first",
    "",
    "   more of it",
    "",
    "     code",
    "",
    "2. second",
    "",
  ]);
  // The code panel starts under the item's text, not at the margin.
  expect(same(cell(3, 4).bg, PANEL)).toBe(true);
  expect(same(cell(2, 4).bg, PANEL)).toBe(false);
});

test("code sits on its panel, its language on the right, colored by Tree-sitter", async () => {
  await show("```ts\nconst a = 1;\n```");
  expect(rows()[0]).toBe(`  const a = 1;${" ".repeat(WIDTH - 17)}ts`);
  for (const x of [0, 30, WIDTH - 1]) expect(same(cell(x, 0).bg, PANEL)).toBe(true);
  for (let i = 0; i < 50 && same(cell(2, 0).fg, cell(8, 0).fg); i++) {
    await Bun.sleep(20);
    await ui?.renderOnce();
  }
  // `const` is a keyword, `a` is not.
  expect(same(cell(2, 0).fg, RGBA.fromHex("#ff7b72"))).toBe(true);
  expect(same(cell(8, 0).fg, cell(2, 0).fg)).toBe(false);
});

test("typing Markdown turns it into what it means on screen, and reports Markdown", async () => {
  const log: string[] = [];
  await show("", log);
  await act(async () => {
    await ui?.mockInput.typeText("# Hello");
    ui?.mockInput.pressEnter();
    await ui?.mockInput.typeText("some **bold** text");
  });
  await ui?.renderOnce();
  expect(rows()[1]).toBe("  Hello");
  expect(rows()).toContain("some bold text");
  expect(log.at(-1)).toBe("# Hello\n\nsome **bold** text");
});

test("text wraps at the reading width; bands and panels still reach the edge", async () => {
  ui = await testRender(
    <box width={WIDTH} height={10}>
      <MarkdownEditor
        value={"## Title\n\nwords words words words words words"}
        syntaxStyle={style}
        terminalBackground={TERMINAL}
        readingWidth={20}
        flexGrow={1}
      />
    </box>,
    { width: WIDTH, height: 10 },
  );
  await ui.renderOnce();
  expect(rows().slice(2, 4)).toEqual(["words words words", "words words words"]);
  // The band fades over the whole editor, past the reading width.
  expect(same(cell(40, 0).bg, TERMINAL)).toBe(false);
});
