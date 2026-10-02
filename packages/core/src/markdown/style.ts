import { RGBA, SyntaxStyle, type StyleDefinition } from "@opentui/core";

/**
 * The few colors a Markdown look is made of. Everything else (code tokens, diffs, quotes,
 * links) is derived from them, so an application states its palette once and `<Markdown>`,
 * `@luciole-sh/markdown-editor` and its own code views agree.
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
  /** The quieter band behind H3 (H4 to H6 have none: a bar, then plain bold). */
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

// How far a quote's bar goes from the accent toward the band: present, not loud.
const QUOTE_BAR = 0.45;
// How far operators and punctuation step back from the text toward the muted color.
const OPERATOR = 0.4;
const PUNCTUATION = 0.65;
// A warning's color: between the accent and danger, as orange sits between.
const WARNING = 0.45;
/** `from` moved toward `to` by `amount` (0 to 1). */
function mix(from: string, to: string, amount: number) {
  const a = RGBA.fromHex(from);
  const b = RGBA.fromHex(to);
  const at = (x: number, y: number) => x + (y - x) * amount;
  return RGBA.fromValues(at(a.r, b.r), at(a.g, b.g), at(a.b, b.b), 1);
}

/**
 * A complete `SyntaxStyle` for Markdown and the code it holds, from a palette: heading
 * bands, a code panel, clickable-looking links, and the Tree-sitter groups of the grammars
 * luciole ships (`@luciole-sh/core/grammars`). Client-only: a `SyntaxStyle` is a native object.
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
    "markup.heading.4": fg(palette.accent, { bold: true }),
    "markup.heading.5": fg(palette.text, { bold: true }),
    "markup.heading.6": fg(palette.muted, { bold: true }),
    "markup.strong": { bold: true },
    "markup.italic": { italic: true },
    "markup.strikethrough": fg(palette.muted, { dim: true }),
    "markup.quote": fg(palette.muted, { italic: true }),
    "markup.quote.bar": { fg: mix(palette.accent, palette.band, QUOTE_BAR) },
    "markup.raw": fg(palette.code),
    "markup.raw.block": { bg: hex(palette.panel) },
    "markup.raw.inline": { bg: hex(palette.panel) },
    // In code a grammar colors, what it leaves uncolored is text, not a string.
    "markup.raw.code": fg(palette.text),
    "markup.link": fg(palette.link, { underline: true }),
    "markup.link.label": fg(palette.link, { underline: true }),
    "markup.link.url": fg(palette.muted, { underline: true }),
    // What notes write beyond CommonMark: ==highlights== and <mark>, <kbd> keys, footnotes,
    // and GitHub's alerts, a color each.
    "markup.highlight": fg(palette.onBand, { bg: hex(palette.band) }),
    "markup.kbd": fg(palette.text, { bg: hex(palette.panel), bold: true }),
    "markup.underline": { underline: true },
    "markup.footnote": fg(palette.muted),
    "markup.math": fg(palette.text, { italic: true }),
    "markup.alert.note": fg(palette.link, { bold: true }),
    "markup.alert.tip": fg(palette.ok, { bold: true }),
    "markup.alert.important": fg(palette.accent, { bold: true }),
    "markup.alert.warning": { fg: mix(palette.accent, palette.danger, WARNING), bold: true },
    "markup.alert.caution": fg(palette.danger, { bold: true }),
    // An image the terminal cannot draw, or not yet: its alternative text, as a link reads.
    "markup.image": fg(palette.link, { italic: true }),
    "markup.image.missing": fg(palette.muted, { italic: true }),
    "markup.list": fg(palette.accent),
    "markup.list.checked": fg(palette.ok),
    "markup.list.unchecked": fg(palette.muted),
    keyword: fg(palette.danger, { bold: true }),
    "keyword.operator": fg(palette.danger),
    string: fg(palette.code),
    "string.special": fg(palette.code),
    // A key in data (JSON, YAML, TOML) in the color GitHub gives it: the structure reads first.
    "string.special.key": fg(palette.ok),
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
    "tag.attribute": fg(palette.link),
    // Names read as text; what only structures the code steps back, so that strings,
    // keywords and calls stand out.
    variable: fg(palette.text),
    "variable.parameter": fg(palette.text, { italic: true }),
    parameter: fg(palette.text, { italic: true }),
    "variable.member": fg(palette.text),
    none: fg(palette.text),
    embedded: fg(palette.text),
    operator: { fg: mix(palette.text, palette.muted, OPERATOR) },
    punctuation: { fg: mix(palette.text, palette.muted, PUNCTUATION) },
    delimiter: { fg: mix(palette.text, palette.muted, PUNCTUATION) },
    "punctuation.special": fg(palette.accent),
    "string.escape": fg(palette.link),
    "string.regexp": fg(palette.link),
    "character.special": fg(palette.link),
    "function.builtin": fg(palette.accent, { italic: true }),
    "function.macro": fg(palette.accent, { italic: true }),
    "type.builtin": fg(palette.ok, { italic: true }),
    "constant.builtin": fg(palette.link, { bold: true }),
    "comment.documentation": fg(palette.muted, { italic: true }),
    // Code blocks tagged diff or patch, colored line by line.
    "diff.plus": fg(palette.ok),
    "diff.minus": fg(palette.danger),
    "diff.delta": fg(palette.link),
    "diff.header": fg(palette.muted, { bold: true }),
  });
}
