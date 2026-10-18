/** @jsxImportSource @opentui/react */
import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { RGBA, type SyntaxStyle } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { markdownStyle, syntaxStyle, type MarkdownPalette } from "@luciole-sh/core/client";
import { syntaxFor as harnessStyle } from "../packages/harness/src/ui/syntax";
import { syntaxFor as chatStyle } from "../examples/chat/components/syntax";
import { syntaxFor as filesStyle } from "../examples/files/components/syntax";
import { syntaxFor as forgeStyle } from "../examples/forge/components/syntax";
import { syntaxFor as readerStyle } from "../examples/mdreader/components/syntax";
import { PaletteProvider, useTheme } from "../examples/notes/components/theme";

const opened: { renderer: { destroy(): void } }[] = [];
afterEach(() => {
  for (const ui of opened.splice(0)) ui.renderer.destroy();
});
const renderer = async () => {
  const ui = await createTestRenderer({});
  opened.push(ui);
  return ui.renderer;
};

test("syntax helpers preserve supplied colors and Markdown groups", async () => {
  const owner = await renderer();
  const text = RGBA.fromHex("#123456");
  const custom = syntaxStyle({ default: { fg: text, bold: true } }, owner);
  expect(custom.getStyle("default")).toMatchObject({ fg: text, bold: true });
  const palette: MarkdownPalette = {
    text: "#e6edf3",
    muted: "#8b949e",
    faint: "#484f58",
    accent: "#e8b84a",
    onBand: "#fbe7b5",
    band: "#3a3020",
    bandQuiet: "#2b2519",
    code: "#a5d6ff",
    panel: "#161b22",
    link: "#79c0ff",
    danger: "#ff7b72",
    ok: "#7ee787",
  };
  const markdown = markdownStyle(palette, owner);
  expect(markdown.getStyle("default")?.fg).toEqual(RGBA.fromHex(palette.text));
  expect(markdown.getStyle("markup.heading.1")).toMatchObject({
    fg: RGBA.fromHex(palette.onBand),
    bg: RGBA.fromHex(palette.band),
    bold: true,
  });
  expect(markdown.getStyle("diff.plus")?.fg).toEqual(RGBA.fromHex(palette.ok));
});

test("harness and examples reuse styles only within one renderer", async () => {
  const first = await renderer();
  const second = await renderer();
  for (const style of [chatStyle, filesStyle, forgeStyle, readerStyle]) {
    expect(style(first)).toBe(style(first));
    expect(style(first)).not.toBe(style(second));
    expect(style(first).getStyle("default")).toEqual(style(second).getStyle("default"));
  }
  expect(harnessStyle(first)).toBe(harnessStyle(first));
  expect(harnessStyle(first).syntax).not.toBe(harnessStyle(second).syntax);
  expect(harnessStyle(first).muted).not.toBe(harnessStyle(second).muted);
  first.destroy();
  opened.splice(0, 1);
  expect(harnessStyle(second).syntax.getStyle("default")).toBeDefined();
});

test("Notes caches each palette separately for each renderer", async () => {
  const seen: SyntaxStyle[][] = [[], []];
  function Probe({ index }: { index: number }) {
    const { syntax } = useTheme();
    seen[index]?.push(syntax);
    return <text>palette</text>;
  }
  const first = await testRender(
    <PaletteProvider>
      <Probe index={0} />
    </PaletteProvider>,
    {},
  );
  opened.push(first);
  const second = await testRender(
    <PaletteProvider>
      <Probe index={1} />
    </PaletteProvider>,
    {},
  );
  opened.push(second);
  const dark = seen[0]?.at(-1);
  expect(dark).toBeDefined();
  expect(dark).not.toBe(seen[1]?.at(-1));
  Object.defineProperty(first.renderer, "themeMode", { value: "light", configurable: true });
  await act(async () => {
    first.renderer.emit("theme_mode", "light");
  });
  const light = seen[0]?.at(-1);
  expect(light).toBeDefined();
  expect(light).not.toBe(dark);
  expect(seen[1]?.at(-1)).not.toBe(light);
  Object.defineProperty(first.renderer, "themeMode", { value: "dark", configurable: true });
  await act(async () => {
    first.renderer.emit("theme_mode", "dark");
  });
  expect(seen[0]?.at(-1)).toBe(dark);
});
