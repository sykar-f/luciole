import { RGBA, SyntaxStyle, type StyleDefinition } from "@opentui/core";

/**
 * The few colors a Markdown look is made of. Everything else (code tokens, diffs, quotes,
 * links) is derived from them, so an application states its palette once and `<Markdown>`,
 * `@luciole/editor` and its own code views agree.
 */
export type MarkdownPalette = {
  /** Body text. */
  text: string;
  /** Quotes, comments, labels. */
  muted: string;
  /** Rules, quote bars, markers that step back. */
  faint: string;
  /** The application's own color: headings, list bullets, function names. */
  accent: string;
  /** Text drawn on the H1 and H2 bands. */
  onBand: string;
  /** The band behind H1 and H2, fading out to the right. */
  band: string;
  /** The quieter band behind H3. */
  bandQuiet: string;
  /** Inline code and strings. */
  code: string;
  /** The panel behind code blocks. */
  panel: string;
  /** Links, numbers, constants. */
  link: string;
  /** Keywords, removed lines. */
  danger: string;
  /** Types, tags, added lines. */
  ok: string;
};

/**
 * A complete `SyntaxStyle` for Markdown and the code it holds, from a palette: heading
 * bands, a code panel, clickable-looking links, and the Tree-sitter groups of the grammars
 * luciole ships (`luciole/grammars`). Client-only: a `SyntaxStyle` is a native object.
 */
export function markdownStyle(palette: MarkdownPalette): SyntaxStyle {
  const hex = (value: string) => RGBA.fromHex(value);
  const fg = (value: string, extra: Omit<StyleDefinition, "fg"> = {}): StyleDefinition => ({
    fg: hex(value),
    ...extra,
  });
  return SyntaxStyle.fromStyles({
    default: fg(palette.text),
    conceal: fg(palette.faint),
    "markup.heading": fg(palette.accent, { bold: true }),
    "markup.heading.1": fg(palette.onBand, { bg: hex(palette.band), bold: true }),
    "markup.heading.2": fg(palette.onBand, { bg: hex(palette.band), bold: true }),
    "markup.heading.3": fg(palette.accent, { bg: hex(palette.bandQuiet), bold: true }),
    "markup.strong": { bold: true },
    "markup.italic": { italic: true },
    "markup.strikethrough": fg(palette.muted, { dim: true }),
    "markup.quote": fg(palette.muted, { italic: true }),
    "markup.raw": fg(palette.code),
    "markup.raw.block": { bg: hex(palette.panel) },
    "markup.link": fg(palette.link, { underline: true }),
    "markup.link.label": fg(palette.link, { underline: true }),
    "markup.link.url": fg(palette.muted, { underline: true }),
    "markup.list": fg(palette.accent),
    "markup.list.checked": fg(palette.ok),
    "markup.list.unchecked": fg(palette.muted),
    keyword: fg(palette.danger, { bold: true }),
    string: fg(palette.code),
    "string.special": fg(palette.code),
    escape: fg(palette.link),
    comment: fg(palette.muted, { italic: true }),
    number: fg(palette.link),
    boolean: fg(palette.link),
    constant: fg(palette.link),
    property: fg(palette.link),
    attribute: fg(palette.link),
    label: fg(palette.link),
    function: fg(palette.accent),
    type: fg(palette.ok),
    constructor: fg(palette.ok),
    module: fg(palette.ok),
    namespace: fg(palette.ok),
    "variable.builtin": fg(palette.ok),
    tag: fg(palette.ok),
    // Code blocks tagged diff or patch, colored line by line.
    "diff.plus": fg(palette.ok),
    "diff.minus": fg(palette.danger),
    "diff.delta": fg(palette.link),
    "diff.header": fg(palette.muted, { bold: true }),
  });
}
