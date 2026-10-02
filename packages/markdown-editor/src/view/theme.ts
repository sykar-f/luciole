import { createTextAttributes, RGBA, type StyleDefinition, type SyntaxStyle } from "@opentui/core";
import type { Block, Marks } from "../model/types.ts";

// The editor's look, read from the same `SyntaxStyle` groups as luciole's `<Markdown>`
// (`markup.heading.1`, `markup.strong`, `markup.raw.block`…): one style, and a note looks
// the same being read or being written.

export type Look = { fg: RGBA; bg?: RGBA; attributes: number };

const FALLBACK_FG = RGBA.fromHex("#c9d1d9");
const FALLBACK_FAINT = RGBA.fromHex("#6e7681");
const FALLBACK_SELECTION = RGBA.fromHex("#264f78");
/** Heading levels drawn apart: all six of Markdown's. */
export const HEADING_LEVELS = 6;

export class Theme {
  private readonly syntax: SyntaxStyle;
  private readonly cache = new Map<string, StyleDefinition | undefined>();
  private readonly looks = new Map<string, Look>();
  readonly selection: RGBA;

  constructor(syntax: SyntaxStyle, options: { selection?: RGBA } = {}) {
    this.syntax = syntax;
    this.selection = options.selection ?? this.lookup("markup.raw.block")?.bg ?? FALLBACK_SELECTION;
  }

  /** A group, then its parents: `markup.link.label`, `markup.link`, `markup`. */
  private lookup(group: string) {
    if (this.cache.has(group)) return this.cache.get(group);
    let style: StyleDefinition | undefined;
    for (let name = group; name && !style; name = name.slice(0, Math.max(0, name.lastIndexOf("."))))
      style = this.syntax.getStyle(name);
    this.cache.set(group, style);
    return style;
  }

  /** `groups` from outermost to innermost, combined: attributes add up, the innermost color wins. */
  look(groups: readonly string[]): Look {
    const key = groups.join("|");
    const known = this.looks.get(key);
    if (known) return known;
    let fg = this.lookup("default")?.fg ?? FALLBACK_FG;
    let bg: RGBA | undefined;
    const flags = {
      bold: false,
      italic: false,
      underline: false,
      dim: false,
      strikethrough: false,
    };
    for (const group of groups) {
      const style = this.lookup(group);
      if (!style) continue;
      fg = style.fg ?? fg;
      bg = style.bg ?? bg;
      flags.bold ||= style.bold === true;
      flags.italic ||= style.italic === true;
      flags.underline ||= style.underline === true;
      flags.dim ||= style.dim === true;
    }
    if (groups.includes(STRIKE)) flags.strikethrough = true;
    const look = { fg, ...(bg ? { bg } : {}), attributes: createTextAttributes(flags) };
    this.looks.set(key, look);
    return look;
  }

  /** The groups a block's text starts from. Text in a quote is quoted text. */
  blockGroups(block: Block): string[] {
    const quoted = (block.quote ?? 0) > 0 ? ["markup.quote"] : [];
    switch (block.type) {
      case "heading": {
        const level = Math.min(block.level, HEADING_LEVELS);
        return [HEADING, `${HEADING}.${level}`];
      }
      case "item":
        return [...quoted, ...(block.list === "task" && block.checked ? [STRIKE] : [])];
      case "code":
      case "raw":
        return ["markup.raw"];
      default:
        return quoted;
    }
  }

  /** The groups a run of marked text adds. */
  markGroups(marks: Marks): string[] {
    const groups: string[] = [];
    if (marks.bold) groups.push("markup.strong");
    if (marks.italic) groups.push("markup.italic");
    if (marks.strike) groups.push(STRIKE);
    if (marks.code) groups.push("markup.raw", "markup.raw.inline");
    if (marks.link !== undefined) groups.push("markup.link");
    if (marks.verbatim) groups.push("markup.link.url");
    return groups;
  }

  /** The band behind a heading, from its style's background: none for the deeper levels. */
  band(level: number): RGBA | undefined {
    if (level > HEADING_LEVELS) return undefined;
    return this.lookup(`${HEADING}.${level}`)?.bg;
  }
  /** The panel behind code blocks. */
  panel(): RGBA | undefined {
    return this.lookup("markup.raw.block")?.bg;
  }
  /** Rules, table borders, the placeholder: what steps back. */
  faint(): RGBA {
    return this.lookup("conceal")?.fg ?? FALLBACK_FAINT;
  }
  /** The bar in a quote's margin: its own color when the style has one, else faint. */
  quoteBar(): RGBA {
    return this.lookup("markup.quote.bar")?.fg ?? this.faint();
  }
  /** A task's box under the pointer: the list's color on the code panel. */
  taskHover(): Look {
    const look = this.look(["markup.list"]);
    const bg = this.panel();
    return bg ? { ...look, bg } : look;
  }
  marker(groups: readonly string[] = []): Look {
    return this.look(["markup.list", ...groups]);
  }
  label(): Look {
    return this.look(["comment"]);
  }
}

const HEADING = "markup.heading";
const STRIKE = "markup.strikethrough";
