/** @jsxImportSource @opentui/react */
import { afterEach, expect, test } from "bun:test";
import { act, type ReactNode, useEffect, useState } from "react";
import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { Markdown } from "../packages/airtty/src/markdown/Markdown";
import { Palette } from "../packages/airtty/src/markdown/render";
import { type Block, MarkdownStream } from "../packages/airtty/src/markdown/stream";
import { syntax } from "../examples/coder/components/syntax";
import { color } from "../examples/coder/components/theme";
import { MARKDOWN_REPLY } from "../examples/coder/server/adapters/fake";

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
    <box width={width} flexDirection="column">
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

test("apart from headings, a finished reply looks as OpenTUI's <markdown conceal> draws it", async () => {
  // Headings are drawn on bands, with their own spacing (next test): left out here.
  const content = (await fixture("rich"))
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

test("headings sit on bands that fade out at fixed columns, spaced by level", async () => {
  const content = "# Plan\n\nText.\n\n## Step\n\n### Detail\nMore.\n\n## Next\n\nEnd.";
  const setup = await render(
    <Markdown content={content} streaming={false} syntaxStyle={syntax} />,
    100,
    20,
  );
  await settled(setup);
  const rows = setup
    .captureCharFrame()
    .split("\n")
    .map((row) => row.trimEnd());
  // H1: three rows, title in the middle; H3: no blank line below; H2 after an H3: two above.
  expect(rows.slice(0, 16)).toEqual([
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
    "",
  ]);
  const spans = setup.captureSpans().lines;
  const bgAt = (row: number, column: number) => {
    let start = 0;
    for (const span of spans[row]?.spans ?? []) {
      if (column < start + span.width) return span.bg;
      start += span.width;
    }
    return undefined;
  };
  const band = RGBA.fromHex(color.accentDim);
  const opaque = (row: number, column: number) => {
    const bg = bgAt(row, column);
    return bg !== undefined && bg.a === 1 && bg.equals(band);
  };
  // Full under the title and up to where the fade starts, all three rows of the H1.
  for (const row of [0, 1, 2]) {
    expect(opaque(row, 0)).toBe(true);
    expect(opaque(row, 27)).toBe(true);
    expect(opaque(row, 40)).toBe(false);
    expect(bgAt(row, 85)?.a ?? 0).toBe(0);
  }
  expect(opaque(6, 17)).toBe(true);
  expect(opaque(6, 30)).toBe(false);
  // The title keeps no background of its own: the band shows through.
  expect(opaque(1, 3)).toBe(true);
});

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
  for (const piece of content.matchAll(/[\s\S]{1,3}/g)) {
    await act(async () => {
      show({ content: content.slice(0, piece.index + piece[0].length), streaming: true });
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
