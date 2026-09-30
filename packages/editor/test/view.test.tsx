/**
 * What the editor draws, cell by cell: OpenTUI renders it, the test reads characters and
 * colors back. The heading bands are the ones luciole's <Markdown> draws.
 */
import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { RGBA, SyntaxStyle } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { MarkdownEditor, parseMarkdown } from "../src/index.ts";
import { layoutDocument } from "../src/view/layout.ts";
import { Theme } from "../src/view/theme.ts";

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
  "markup.list.unchecked": { fg: RGBA.fromHex("#8b98a5") },
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

test("each level reads apart: shorter bands down to H3, then a bar, then capitals", async () => {
  await show("## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six");
  const frame = rows();
  expect(frame.slice(0, 9)).toEqual([
    "  Two",
    "",
    "  Three",
    "",
    "▎ Four",
    "",
    "▏ Five",
    "",
    "SIX",
  ]);
  // Exactly the band up to its column, clearly fading a little further, gone before the edge.
  expect(same(cell(17, 0).bg, BAND)).toBe(true);
  expect(distance(cell(30, 0).bg, BAND)).toBeGreaterThan(distance(cell(17, 0).bg, BAND));
  expect(same(cell(45, 0).bg, BAND)).toBe(false);
  // An H3's band is quieter, and shorter.
  expect(same(cell(11, 2).bg, QUIET)).toBe(true);
  expect(distance(cell(20, 2).bg, QUIET)).toBeGreaterThan(0);
  expect(same(cell(30, 2).bg, QUIET)).toBe(false);
  // No band below H3.
  for (const y of [4, 6, 8]) expect(same(cell(6, y).bg, QUIET)).toBe(false);
  // Nothing between the bands: the gaps are the terminal's.
  expect(same(cell(0, 1).bg, BAND) || same(cell(0, 1).bg, QUIET)).toBe(false);
});

test("headings keep the reader's rhythm: two lines above an H1, one under an H3", async () => {
  await show("para\n\n# One\n\ntext\n\n### Three\nunder\n\n## Two after three");
  expect(rows().slice(0, 13)).toEqual([
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
    "",
    "under",
    "",
  ]);
  // An H2 that ends an H3's section stands two lines apart.
  expect(rows()[14]).toBe("  Two after three");
});

test("the document shows as it reads: no Markdown marker on screen", async () => {
  await show(
    [
      // The cursor's block, where links show their address.
      "Intro.",
      "",
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
  expect(rows()).toContain("[ ] a task");
  expect(rows()).toContain("[✓] done");
  expect(rows()).toContain("  ◦ nested");
  expect(rows()).toContain("2. second");
  expect(rows()).toContain("▎ quoted");
  expect(rows()).toContain("▎ ▎ deeper");
  expect(rows()).toContain("▎ • listed in a quote");
  expect(rows().at(-1) ?? rows().findLast((row) => row)).toBeDefined();
  expect(rows().some((row) => row.startsWith("─".repeat(WIDTH)))).toBe(true);
});

test("what an item holds lines up with its text", async () => {
  await show("1. first\n\n   more of it\n\n   ```\n   code\n   ```\n2. second");
  const frame = rows();
  expect(frame.slice(0, 9)).toEqual([
    "1. first",
    "",
    "   more of it",
    "",
    "",
    "     code",
    "",
    "",
    "2. second",
  ]);
  // The code panel (a row of margin above and below the code) starts under the item's
  // text, not at the margin.
  for (const y of [4, 5, 6]) expect(same(cell(3, y).bg, PANEL)).toBe(true);
  expect(same(cell(2, 5).bg, PANEL)).toBe(false);
  expect(same(cell(3, 7).bg, PANEL)).toBe(false);
});

test("code sits on its panel, its language on the right, colored by Tree-sitter", async () => {
  await show("```ts\nconst a = 1;\n```");
  // A row of panel above the code, holding its language, and one below.
  expect(rows().slice(0, 3)).toEqual([`${" ".repeat(WIDTH - 3)}ts`, "  const a = 1;", ""]);
  for (const y of [0, 1, 2])
    for (const x of [0, 30, WIDTH - 1]) expect(same(cell(x, y).bg, PANEL)).toBe(true);
  for (let i = 0; i < 50 && same(cell(2, 1).fg, cell(8, 1).fg); i++) {
    await Bun.sleep(20);
    await ui?.renderOnce();
  }
  // `const` is a keyword, `a` is not.
  expect(same(cell(2, 1).fg, RGBA.fromHex("#ff7b72"))).toBe(true);
  expect(same(cell(8, 1).fg, cell(2, 1).fg)).toBe(false);
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

test("the page is centered at the reading width; bands and panels reach into its margin", async () => {
  ui = await testRender(
    <box width={WIDTH} height={10}>
      <MarkdownEditor
        value={"## Title\n\nwords words words words words words\n\n```\ncode\n```"}
        syntaxStyle={style}
        terminalBackground={TERMINAL}
        readingWidth={20}
        flexGrow={1}
      />
    </box>,
    { width: WIDTH, height: 10 },
  );
  await ui.renderOnce();
  // A page 20 wide in an editor 60 wide: 20 columns of margin on each side, and every
  // text starting at the same column, the title and the code included.
  const margin = " ".repeat(20);
  expect(rows().slice(0, 4)).toEqual([
    `${margin}Title`,
    "",
    `${margin}words words words`,
    `${margin}words words words`,
  ]);
  expect(rows()[6]).toBe(`${margin}code`);
  // The band and the panel start two columns into the margin; neither goes past the page.
  expect(same(cell(18, 0).bg, BAND)).toBe(true);
  expect(same(cell(17, 0).bg, BAND)).toBe(false);
  expect(same(cell(45, 0).bg, BAND)).toBe(false);
  for (const y of [5, 6, 7]) {
    expect(same(cell(18, y).bg, PANEL)).toBe(true);
    expect(same(cell(39, y).bg, PANEL)).toBe(true);
    expect(same(cell(40, y).bg, PANEL)).toBe(false);
  }
});

const TABLE = [
  "| Left | Center | Right |",
  "| :--- | :----: | ----: |",
  "| apples | 3 | 1.20 |",
  "| **pears** | `12` | 4 |",
].join("\n");

test("a table is drawn as one: columns sized and aligned, the header over a rule, boxed", async () => {
  await show(`Fruit:\n\n${TABLE}`);
  expect(rows().slice(2, 8)).toEqual([
    "╭────────┬────────┬───────╮",
    "│ Left   │ Center │ Right │",
    "├────────┼────────┼───────┤",
    "│ apples │   3    │  1.20 │",
    "│ pears  │   12   │     4 │",
    "╰────────┴────────┴───────╯",
  ]);
  // Cells are Markdown too: `12` is code.
  expect(same(cell(13, 6).fg, RGBA.fromHex("#a5d6ff"))).toBe(true);
});

test("a table is edited as its Markdown: the cursor in it shows the pipes", async () => {
  await show(`Fruit:\n\n${TABLE}\n\nafter`);
  expect(rows()[2]).toStartWith("╭");
  const after = rows().indexOf("after");
  await act(async () => {
    ui?.mockInput.pressArrow("down");
  });
  await ui?.renderOnce();
  expect(rows().slice(3, 5)).toEqual(["| Left | Center | Right |", "| :--- | :----: | ----: |"]);
  // The rows of its box are kept: what follows the table does not move.
  expect(rows().indexOf("after")).toBe(after);
});

test("a table too wide for the page narrows its widest columns and wraps their text", async () => {
  const words = "many words that will never fit on one line of a page sixty columns wide";
  await show(`x\n\n| a | b |\n| - | - |\n| 1 | ${words} |`);
  const table = rows().slice(2, 9);
  // As wide as the page, not wider: the long cell wrapped over two rows.
  for (const row of table) expect(row.length).toBeLessThanOrEqual(WIDTH);
  expect(table[0]?.length).toBe(WIDTH);
  expect(table[3]).toStartWith("│ 1 │ many words that will never fit on one line of a page");
  expect(table[4]).toStartWith("│   │ sixty columns wide");
  expect(table[5]).toStartWith("╰");
});

test("a task's box lights up under the pointer, and a click on it ticks it", async () => {
  const log: string[] = [];
  await show("- [ ] a task", log);
  expect(same(cell(0, 0).bg, PANEL)).toBe(false);
  await ui?.mockMouse.moveTo(1, 0);
  await ui?.renderOnce();
  expect(same(cell(0, 0).bg, PANEL)).toBe(true);
  expect(same(cell(1, 0).fg, RGBA.fromHex("#e8b84a"))).toBe(true);
  // Off the box, back as it was.
  await ui?.mockMouse.moveTo(8, 0);
  await ui?.renderOnce();
  expect(same(cell(0, 0).bg, PANEL)).toBe(false);
  await act(async () => {
    await ui?.mockMouse.click(1, 0);
  });
  expect(log.at(-1)).toBe("- [x] a task");
});

test("an image the terminal cannot draw shows its alternative text", async () => {
  await show("x\n\n![The mark](https://example.com/mark.png)\n\nSee ![a logo](logo.png) here.");
  expect(rows()[2]).toBe("▣ The mark");
  expect(rows()[4]).toBe("See ▣ a logo here.");
});

test("link definitions and HTML comments step back; two lists in a row stand apart", async () => {
  await show("x\n\n[ref]: https://x.y\n\n<!-- note -->\n\n- a\n* b\n\n1. one\n2. two");
  expect(rows().slice(0, 9)).toEqual([
    "x",
    "",
    "[ref]: https://x.y",
    "",
    "<!-- note -->",
    "",
    "• a",
    "",
    "• b",
  ]);
  expect(same(cell(0, 2).fg, RGBA.fromHex("#4a5561"))).toBe(true);
});

test("the numbers of an ordered list line up on the right", async () => {
  const items = Array.from({ length: 10 }, (_, i) => `${i + 1}. item`).join("\n");
  await show(items);
  expect(rows().slice(0, 10)).toEqual([
    " 1. item",
    " 2. item",
    " 3. item",
    " 4. item",
    " 5. item",
    " 6. item",
    " 7. item",
    " 8. item",
    " 9. item",
    "10. item",
  ]);
});

test("an image the terminal draws takes its own size in cells, up to the page's width", () => {
  const doc = parseMarkdown("[![logo][l]](https://x.y)\n\n[l]: https://x.y/logo.png");
  const options = {
    image: () => ({ width: 160, height: 80 }),
    cell: { width: 8, height: 16 },
  };
  const lines = layoutDocument(doc, WIDTH, new Theme(style), options).lines;
  const image = lines.filter((line) => line.image);
  // 160 pixels are 20 cells of 8; 80 pixels at that scale, 5 rows of 16.
  expect(image.map((line) => line.image?.row)).toEqual([0, 1, 2, 3, 4]);
  expect(image[0]?.image).toEqual({
    url: "https://x.y/logo.png",
    row: 0,
    rows: 5,
    cols: 20,
    link: "https://x.y",
  });
  // Wider than the page, it is narrowed to it, its height with it.
  const wide = layoutDocument(doc, WIDTH, new Theme(style), {
    ...options,
    image: () => ({ width: 1600, height: 400 }),
  }).lines.find((line) => line.image)?.image;
  expect(wide).toMatchObject({ cols: WIDTH, rows: 8 });
  // Edited, it is its Markdown again.
  const revealed = layoutDocument(doc, WIDTH, new Theme(style), { ...options, revealed: 0 });
  expect(revealed.lines.some((line) => line.image)).toBe(false);
  expect(revealed.lines[0]?.glyphs.map((g) => g.text).join("")).toBe("![logo][l] (https://x.y)");
});

test("ticking a task far down the page keeps the page where it is", async () => {
  const log: string[] = [];
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n\n");
  await show(`${lines}\n\n- [ ] far task`, log);
  for (let i = 0; i < 30; i++) await ui?.mockMouse.scroll(10, 10, "down");
  await ui?.renderOnce();
  const row = rows().findIndex((text) => text.includes("far task"));
  expect(row).toBeGreaterThan(0);
  await act(async () => {
    await ui?.mockMouse.click(1, row);
  });
  await ui?.renderOnce();
  expect(log.at(-1)).toEndWith("- [x] far task");
  expect(rows()[row]).toContain("far task");
});

test("Down at the end of code that ends the document leaves it for a new paragraph", async () => {
  const log: string[] = [];
  await show("text\n\n```\ncode\n```", log);
  await act(async () => {
    for (let i = 0; i < 4; i++) ui?.mockInput.pressArrow("down");
    await ui?.mockInput.typeText("after");
  });
  expect(log.at(-1)).toBe("text\n\n```\ncode\n```\n\nafter");
});

test("in the block being edited, a link shows its address; elsewhere only its text", async () => {
  await show("see [site](https://x.y) now\n\nand [there](https://z.w)");
  expect(rows()[0]).toBe("see site (https://x.y) now");
  expect(rows()[2]).toBe("and there");
});

test("what notes write beyond CommonMark reads as it means, and as written where edited", async () => {
  await show(
    [
      "a ==hi== b[^1] :tada:",
      "",
      "a ==hi== b[^1] :tada: :nope:",
      "",
      "> [!WARNING]",
      "> Mind the step.",
      "",
      "press <kbd>Ctrl</kbd>+<kbd>C</kbd>, H<sub>2</sub>O, x<sup>2</sup> <!-- hidden -->",
      "",
      "one<br>two",
      "",
      "[^1]: The note itself.",
    ].join("\n"),
  );
  const frame = rows();
  // The cursor's block keeps its syntax, faint; the others read as they mean.
  expect(frame[0]).toBe("a ==hi== b[^1] :tada:");
  expect(frame[2]).toBe("a hi b¹ 🎉 :nope:");
  expect(frame.slice(4, 6)).toEqual(["▎ ⚠ Warning", "▎ Mind the step."]);
  expect(frame[7]).toBe("press  Ctrl + C , H₂O, x²");
  expect(frame.slice(9, 11)).toEqual(["one", "two"]);
  expect(frame[12]).toBe("¹ The note itself.");
});
