/** @jsxImportSource @opentui/react */
import { afterEach, expect, spyOn, test } from "bun:test";
import { act, type ReactNode, useEffect, useState } from "react";
import { CliRenderer, RGBA } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { Markdown } from "../packages/core/src/markdown/Markdown";
import { Palette } from "../packages/core/src/markdown/render";
import { type Block, MarkdownStream } from "../packages/core/src/markdown/stream";
import { syntax } from "../packages/harness/src/ui/syntax";
import { color } from "../packages/harness/src/ui/theme";
import { MARKDOWN_REPLY } from "../packages/harness/src/adapters/fake";

const fixture = (name: string) =>
  Bun.file(new URL(`./fixtures/markdown/${name}.md`, import.meta.url)).text();
const palette = () => new Palette(syntax, { hyperlinks: false });
const WORDS = /\S+\s*/g;

type Setup = Awaited<ReturnType<typeof testRender>>;
let opened: Setup[] = [];
afterEach(() => {
  for (const setup of opened) setup.renderer.destroy();
  opened = [];
});
async function render(node: ReactNode, width = 80, height = 120) {
  const setup = await testRender(
    <box width="100%" flexDirection="column">
      {node}
    </box>,
    { width, height },
  );
  opened.push(setup);
  return setup;
}
const trimmed = (frame: string) =>
  frame
    .split("\n")
    .map((row) => row.trimEnd())
    .join("\n")
    .trimEnd();
/** The frame once Tree-sitter answered: showing `until`, then unchanged for several passes. */
async function settled(setup: Setup, until = "") {
  let frame = "";
  let stable = 0;
  for (let pass = 0; pass < 200 && stable < 10; pass++) {
    await act(async () => {
      await setup.renderOnce();
      await Bun.sleep(10);
    });
    const next = trimmed(setup.captureCharFrame());
    stable = next === frame && next.includes(until) ? stable + 1 : 0;
    frame = next;
  }
  return frame;
}

test("every block but the one being written is drawn once, as the finished reply draws it", async () => {
  for (const content of [MARKDOWN_REPLY, await fixture("rich")]) {
    const final = new MarkdownStream(palette()).update(content, false);
    const stream = new MarkdownStream(palette());
    const frozen = new Map<string, Block["nodes"]>();
    // Every prefix: the stream is cut anywhere.
    for (let end = 1; end <= content.length; end++) {
      const blocks = stream.update(content.slice(0, end), true);
      for (const [index, block] of blocks.slice(0, -1).entries()) {
        const before = frozen.get(block.key);
        if (before) expect(block.nodes).toBe(before);
        else expect(block.nodes).toEqual(final[index]?.nodes ?? []);
        frozen.set(block.key, block.nodes);
      }
    }
  }
});

test("a streamed reply ends as the finished reply draws it", async () => {
  for (const content of [MARKDOWN_REPLY, await fixture("rich"), await fixture("edge")]) {
    const streamed = new MarkdownStream(palette());
    for (const end of content.matchAll(WORDS))
      streamed.update(content.slice(0, end.index + end[0].length), true);
    expect(streamed.update(content, true)).toEqual(
      new MarkdownStream(palette()).update(content, false),
    );
  }
});

test("a reference link resolves once its definition is complete, not at each character", () => {
  const content = "See [the docs][d].\n\n[d]: https://example.com/docs";
  const stream = new MarkdownStream(palette());
  const seen = new Set<string>();
  const shown = (blocks: readonly Block[]) => {
    const first = blocks[0]?.nodes[0];
    if (first?.kind === "text") seen.add(first.chunks.map((chunk) => chunk.text).join(""));
  };
  // From the paragraph's end on: before, it is the block being written.
  for (let end = content.indexOf("\n\n"); end <= content.length; end++)
    shown(stream.update(content.slice(0, end), true));
  shown(stream.update(content, false));
  expect([...seen]).toEqual(["See [the docs][d].", "See the docs (https://example.com/docs)."]);
});

test("apart from headings and code blocks, a finished reply looks as OpenTUI's <markdown conceal> draws it", async () => {
  // Headings (bands) and code blocks (a panel) have their own look: left out here.
  const content = (await fixture("rich"))
    .replace(/^```[^\n]*\n[\s\S]*?\n```\n\n/gm, "")
    .replace(/^#{1,6} .*\n\n/gm, "")
    .replace(/^.+\n-+\n\n/m, "");
  const theirs = await settled(
    await render(<markdown content={content} conceal syntaxStyle={syntax} />),
    "Final paragraph",
  );
  const ours = await settled(
    await render(<Markdown content={content} streaming={false} syntaxStyle={syntax} />),
  );
  expect(ours).toBe(theirs);
  expect(ours).toContain("Here is what I found in this project, with emphasis, inline code");
  expect(ours).toContain("  - unit tests;");
});

/** The background of the cell at `row`, `column` of the last frame. */
const backgroundAt = (setup: Setup, row: number, column: number) => {
  let start = 0;
  for (const span of setup.captureSpans().lines[row]?.spans ?? []) {
    if (column < start + span.width) return span.bg;
    start += span.width;
  }
  return undefined;
};
const HEADINGS = "# Plan\n\nText.\n\n## Step\n\n### Detail\nMore.\n\n## Next\n\nEnd.";

test("headings sit on bands, spaced by level", async () => {
  const setup = await render(
    <Markdown content={HEADINGS} streaming={false} syntaxStyle={syntax} />,
    100,
    20,
  );
  const rows = (await settled(setup)).split("\n");
  // H1: three rows, title in the middle; H3: no blank line below; H2 after an H3: two above.
  expect(rows.slice(0, 15)).toEqual([
    "",
    "  Plan",
    "",
    "",
    "Text.",
    "",
    "  Step",
    "",
    "  Detail",
    "More.",
    "",
    "",
    "  Next",
    "",
    "End.",
  ]);
  const band = RGBA.fromHex(color.accentDim);
  const full = (row: number, column: number) => {
    const bg = backgroundAt(setup, row, column);
    return bg !== undefined && bg.a === 1 && bg.equals(band);
  };
  // Full under the title and up to where the fade starts, on all three rows of the H1; the
  // title keeps no background of its own.
  for (const row of [0, 1, 2]) {
    expect(full(row, 0)).toBe(true);
    expect(full(row, 3)).toBe(true);
    expect(full(row, 27)).toBe(true);
    expect(full(row, 40)).toBe(false);
  }
  expect(full(6, 17)).toBe(true);
  expect(full(6, 30)).toBe(false);
});

test("a band fades out up to the right edge, which follows a resize", async () => {
  // A terminal that never reports its background: the fade is in alpha, which OpenTUI
  // blends into an empty cell, so it darkens (the terminal's own background is unknown).
  const palette = spyOn(CliRenderer.prototype, "getPalette").mockRejectedValue(
    new Error("no OSC 11 answer"),
  );
  try {
    const setup = await render(
      <Markdown content={HEADINGS} streaming={false} syntaxStyle={syntax} />,
      100,
      20,
    );
    await settled(setup);
    const painted = (column: number) => (backgroundAt(setup, 1, column)?.a ?? 0) > 0;
    const light = (column: number) => {
      const bg = backgroundAt(setup, 1, column);
      return bg ? bg.r + bg.g + bg.b : 0;
    };
    expect(light(60)).toBeGreaterThan(light(80));
    expect(painted(90)).toBe(true);
    expect(painted(99)).toBe(false);
    await act(async () => {
      setup.resize(60, 20);
    });
    await settled(setup);
    expect(painted(50)).toBe(true);
    expect(painted(59)).toBe(false);
  } finally {
    palette.mockRestore();
  }
});

test("with the terminal's background known, a band fades into it, not into black", async () => {
  const background = "#20242c";
  const palette = spyOn(CliRenderer.prototype, "getPalette").mockResolvedValue({
    palette: [],
    defaultForeground: "#e6edf3",
    defaultBackground: background,
    cursorColor: null,
    mouseForeground: null,
    mouseBackground: null,
    tekForeground: null,
    tekBackground: null,
    highlightBackground: null,
    highlightForeground: null,
  });
  try {
    const setup = await render(
      <Markdown content="# Plan" streaming={false} syntaxStyle={syntax} />,
      100,
      5,
    );
    await settled(setup);
    const end = RGBA.fromHex(background);
    const cell = backgroundAt(setup, 1, 93);
    // Opaque, nearly the terminal's background, and never darker than it.
    expect(cell?.a).toBe(1);
    for (const channel of ["r", "g", "b"] as const)
      expect(cell?.[channel] ?? 0).toBeGreaterThanOrEqual(end[channel] - 0.01);
    expect(backgroundAt(setup, 1, 99)?.a ?? 0).toBe(0);
  } finally {
    palette.mockRestore();
  }
});

test("a code block sits on the style's panel, its language in a corner", async () => {
  const setup = await render(
    <Markdown content={"```ts\nconst x = 1;\n```"} streaming={false} syntaxStyle={syntax} />,
    60,
    6,
  );
  const rows = (await settled(setup)).split("\n");
  expect(rows.slice(0, 2)).toEqual([`${" ".repeat(57)}ts`, "  const x = 1;"]);
  const panel = RGBA.fromHex(color.panel);
  for (const [row, column] of [
    [0, 0],
    [1, 0],
    [1, 50],
    [2, 59],
  ] as const)
    expect(backgroundAt(setup, row, column)?.equals(panel)).toBe(true);
});

test("a diff block is colored line by line, even before its closing fence", async () => {
  const diff = "```diff\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n same";
  for (const content of [diff, `${diff}\n\`\`\``]) {
    const setup = await render(
      <Markdown content={content} streaming syntaxStyle={syntax} />,
      40,
      12,
    );
    const rows = (await settled(setup)).split("\n");
    const colorOf = (text: string) => {
      const row = rows.findIndex((line) => line.includes(text));
      return setup.captureSpans().lines[row]?.spans.find((span) => span.text.includes(text))?.fg;
    };
    expect(colorOf("+new")?.equals(RGBA.fromHex(color.ok))).toBe(true);
    expect(colorOf("-old")?.equals(RGBA.fromHex(color.danger))).toBe(true);
    expect(colorOf("@@ -1 +1 @@")?.equals(RGBA.fromHex(color.info))).toBe(true);
    expect(colorOf("same")?.equals(RGBA.fromHex(color.text))).toBe(true);
  }
});

test("a click on a link opens it; a drag across it selects instead", async () => {
  const opened: string[] = [];
  const setup = await render(
    <Markdown
      content="See [the docs](https://example.com/docs) now."
      streaming={false}
      syntaxStyle={syntax}
      onLink={(url) => opened.push(url)}
    />,
  );
  const shown = await settled(setup);
  expect(shown).toBe("See the docs (https://example.com/docs) now.");
  const label = shown.indexOf("the docs");
  // Styled as a link (markup.link), not as plain text.
  const cell = setup.captureSpans().lines[0]?.spans.find((span) => span.text.includes("the docs"));
  expect(cell?.fg.equals(RGBA.fromHex(color.info))).toBe(true);
  await act(async () => {
    await setup.mockMouse.click(label + 2, 0);
  });
  expect(opened).toEqual(["https://example.com/docs"]);
  await act(async () => {
    await setup.mockMouse.drag(label, 0, label + 6, 0);
  });
  expect(opened).toHaveLength(1);
});

test("an image is drawn in place of its text; one that can't load keeps its text", async () => {
  const icon = new URL("../examples/notes/assets/icon.png", import.meta.url).pathname;
  const setup = await render(
    <Markdown
      content={`![notes icon](${icon})\n\n![missing](nowhere/missing.png)\n\nAfter.`}
      streaming={false}
      syntaxStyle={syntax}
      imageBase="/definitely/not/here"
    />,
    60,
    40,
  );
  const shown = await settled(setup, "After.");
  const rows = shown.split("\n");
  // The image took rows of its own, its text is gone; the missing one kept its text.
  expect(shown).not.toContain("notes icon");
  expect(rows.findIndex((row) => row.includes("missing"))).toBeGreaterThan(2);
  expect(shown).toContain("missing");
});

/**
 * The lengths of the prefixes of `content` a stream can stop at that matter: a marker shows
 * only on a prefix that ends right after a character that can open one, so each of those is
 * tried, and, in the plain text between, one every 24 characters. Rendering each of the
 * thousands of three-character prefixes took longer than the suite's timeout on a loaded
 * host, and the plain text between cannot show a marker.
 */
function prefixEnds(content: string) {
  const ends = new Set([content.length]);
  for (let at = 24; at < content.length; at += 24) ends.add(at);
  for (const mark of content.matchAll(/[*_`~#[(!]/g)) ends.add(mark.index + 1);
  return [...ends].sort((x, y) => x - y);
}
/** Where the paragraph that follows a table and its `---` starts. */
const afterRule = (content: string) => content.indexOf("\n---\n\n") + "\n---\n\n".length;
const heightOf = (setup: Setup) =>
  setup
    .captureCharFrame()
    .split("\n")
    .findLastIndex((row) => row.trim() !== "") + 1;

test("while it streams, the reply only grows and never shows a marker it will hide", async () => {
  const content = MARKDOWN_REPLY;
  let show: (props: { content: string; streaming: boolean }) => void = () => undefined;
  function Streamed() {
    const [props, setProps] = useState({ content: "", streaming: true });
    useEffect(() => {
      show = setProps;
    }, []);
    return <Markdown {...props} syntaxStyle={syntax} />;
  }
  const setup = await render(<Streamed />, 100, 400);
  const height = (rows: readonly string[]) => rows.findLastIndex((row) => row.trim() !== "") + 1;
  let previous = 0;
  for (const end of prefixEnds(content)) {
    await act(async () => {
      show({ content: content.slice(0, end), streaming: true });
      await setup.renderOnce();
    });
    const rows = setup.captureCharFrame().split("\n");
    expect(height(rows)).toBeGreaterThanOrEqual(previous);
    expect(rows.find((row) => /\*\*|`|^#{1,6} |\]\(/.test(row))).toBeUndefined();
    previous = height(rows);
  }
  const streamed = await settled(setup);
  await act(async () => {
    show({ content, streaming: false });
  });
  expect(await settled(setup)).toBe(streamed);
});

// A rule is a finished block once its line ends, even when the blank line that follows is
// the lexer's space token and not part of the rule: it must not vanish for one prefix.
test("a rule keeps showing when the blank line after it arrives", () => {
  const stream = new MarkdownStream(palette());
  const kinds = (content: string) =>
    stream.update(content, true).flatMap((block) => block.nodes.map((node) => node.kind));
  expect(kinds("Above.\n\n---\n")).toEqual(["text", "rule"]);
  expect(kinds("Above.\n\n---\n\n")).toEqual(["text", "rule"]);
  expect(kinds("Above.\n\n---\n\nB")).toEqual(["text", "rule", "text"]);
});

test("a paragraph streamed after a table and a rule never shortens the reply", async () => {
  const content = MARKDOWN_REPLY;
  let show: (props: { content: string; streaming: boolean }) => void = () => undefined;
  function Streamed() {
    const [props, setProps] = useState({ content: "", streaming: true });
    useEffect(() => {
      show = setProps;
    }, []);
    return <Markdown {...props} syntaxStyle={syntax} />;
  }
  const setup = await render(<Streamed />, 100, 400);
  const before = afterRule(content);
  // Character by character, from the table's rows to the first characters after the rule.
  const ends = Array.from({ length: before + 4 - 4900 }, (_, i) => 4900 + i);
  let previous = 0;
  let shrunk: number | undefined;
  for (const end of ends) {
    await act(async () => {
      show({ content: content.slice(0, end), streaming: true });
      await setup.renderOnce();
    });
    const height = heightOf(setup);
    if (height < previous) shrunk ??= end;
    previous = height;
  }
  expect(shrunk).toBeUndefined();
});

test("a mouse drag selects the reply's text, markers hidden, for the OSC 52 copy", async () => {
  const setup = await render(
    <Markdown
      content={"Some **bold** words.\n\n- a `code` item"}
      streaming={false}
      syntaxStyle={syntax}
    />,
  );
  await settled(setup);
  await act(async () => {
    await setup.mockMouse.drag(0, 0, 20, 2);
    await setup.renderOnce();
  });
  expect(setup.renderer.getSelection()?.getSelectedText()).toBe("Some bold words.\n- a code item");
});

test("however many blocks a transcript holds, the renderer hears one listener per event", async () => {
  const REPLIES = 12;
  const setup = await render(
    Array.from({ length: REPLIES }, (_, i) => (
      <Markdown key={i} content={`Reply ${i}`} streaming={false} syntaxStyle={syntax} />
    )),
  );
  await act(async () => {
    await setup.renderOnce();
  });
  // Node warns past 10, over the terminal interface; one shared listener stays under it.
  expect(setup.renderer.listenerCount("capabilities")).toBeLessThanOrEqual(1);
  expect(setup.renderer.listenerCount("theme_mode")).toBeLessThanOrEqual(1);
});
