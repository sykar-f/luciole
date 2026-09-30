"use client";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { RGBA, SyntaxStyle } from "@opentui/core";
import { useRenderer } from "@opentui/react";
// Grammars beyond JavaScript, TypeScript and Markdown, for the code blocks of a note.
import "luciole/grammars";

// Two palettes, picked by the terminal's own theme (it reports dark or light, and when it
// switches): the notebook follows the terminal instead of imposing its colors.
const dark = {
  accent: "#e8b84a",
  onAccent: "#1b1608",
  text: "#e6edf3",
  muted: "#8b98a5",
  faint: "#4a5561",
  warn: "#ffbc66",
  danger: "#ff7b72",
  ok: "#7ee787",
  info: "#79c0ff",
  code: "#a5d6ff",
  sidebar: "#161b22",
  hover: "#21262d",
  selected: "#3a3020",
  button: "#21262d",
  buttonHover: "#30363d",
  border: "#30363d",
  menu: "#1c2128",
};
export type Palette = typeof dark;
const light: Palette = {
  accent: "#a86b00",
  onAccent: "#ffffff",
  text: "#1f2328",
  muted: "#59636e",
  faint: "#b0b7be",
  warn: "#9a6700",
  danger: "#cf222e",
  ok: "#1a7f37",
  info: "#0969da",
  code: "#0a3069",
  sidebar: "#f3f1ec",
  hover: "#e9e5dc",
  selected: "#f5e3b8",
  button: "#e9e5dc",
  buttonHover: "#ddd6c8",
  border: "#d0d7de",
  menu: "#fbfaf7",
};

const PaletteContext = createContext<Palette>(dark);
/**
 * Follows the terminal's theme for everything inside: one listener on the renderer,
 * however many controls read the palette.
 */
export function PaletteProvider({ children }: { children: ReactNode }) {
  const renderer = useRenderer();
  const [mode, setMode] = useState(renderer.themeMode);
  useEffect(() => {
    const update = () => setMode(renderer.themeMode);
    update();
    renderer.on("theme_mode", update);
    return () => {
      renderer.off("theme_mode", update);
    };
  }, [renderer]);
  return <PaletteContext value={mode === "light" ? light : dark}>{children}</PaletteContext>;
}
/** The palette matching the terminal's theme, dark until it answers. */
export const usePalette = () => useContext(PaletteContext);

// Client-only: a SyntaxStyle is a native object and never crosses the Flight boundary.
const styles = new WeakMap<Palette, SyntaxStyle>();
function syntaxOf(color: Palette) {
  const known = styles.get(color);
  if (known) return known;
  const hex = (value: string) => RGBA.fromHex(value);
  const style = SyntaxStyle.fromStyles({
    default: { fg: hex(color.text) },
    conceal: { fg: hex(color.faint) },
    "markup.heading": { fg: hex(color.accent), bold: true },
    "markup.heading.1": { fg: hex(color.accent), bold: true },
    "markup.heading.2": { fg: hex(color.accent), bold: true },
    "markup.heading.3": { fg: hex(color.text), bold: true },
    "markup.strong": { bold: true },
    "markup.italic": { italic: true },
    "markup.strikethrough": { fg: hex(color.muted), dim: true },
    "markup.quote": { fg: hex(color.muted), italic: true },
    "markup.raw": { fg: hex(color.code) },
    "markup.raw.block": { bg: hex(color.sidebar) },
    "markup.link": { fg: hex(color.info), underline: true },
    "markup.link.label": { fg: hex(color.info), underline: true },
    "markup.link.url": { fg: hex(color.muted), underline: true },
    "markup.list": { fg: hex(color.accent) },
    keyword: { fg: hex(color.danger), bold: true },
    string: { fg: hex(color.code) },
    comment: { fg: hex(color.muted), italic: true },
    number: { fg: hex(color.info) },
    boolean: { fg: hex(color.info) },
    constant: { fg: hex(color.info) },
    property: { fg: hex(color.info) },
    function: { fg: hex(color.accent) },
    type: { fg: hex(color.ok) },
  });
  styles.set(color, style);
  return style;
}

/** The palette and the Markdown styles that go with it. */
export function useTheme() {
  const color = usePalette();
  const syntax = useMemo(() => syntaxOf(color), [color]);
  return { color, syntax };
}
