import { z } from "zod";
import type { Block } from "./model";
import { color } from "./theme";

// How pi's four tools read in the transcript: a one-line title, then, unfolded, their
// arguments and their result. Arguments come from the model: each is checked, not cast.

export type Tool = Extract<Block, { kind: "tool" }>;
export type Styled = { text: string; fg: string };

// Unfolded, a call shows this many lines of arguments and of output.
export const ARG_LINES = 24;
export const OUTPUT_LINES = 40;
// Collapsed, a running call shows the tail of its output.
export const LIVE_LINES = 4;
const TITLE_CHARS = 200;
const MS_PER_SECOND = 1000;

const Text = z.string();
const Count = z.number().int();
const Edits = z.array(z.object({ oldText: z.string(), newText: z.string() }));

const text = (value: unknown) => {
  const parsed = Text.safeParse(value);
  return parsed.success ? parsed.data : value === undefined ? "" : JSON.stringify(value);
};
const lines = (value: string) => (value === "" ? [] : value.replace(/\n$/, "").split("\n"));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function toolTitle(tool: Tool): string {
  const a = tool.args;
  // While the model writes the arguments, show them as they come.
  if (tool.status === "streaming") return tool.argsText.replace(/\s+/g, " ").slice(-TITLE_CHARS);
  switch (tool.name) {
    case "bash":
      return lines(text(a.command))[0] ?? "";
    case "read": {
      const offset = Count.safeParse(a.offset);
      const limit = Count.safeParse(a.limit);
      return `${text(a.path)}${offset.success ? ` from line ${offset.data}` : ""}${
        limit.success ? `, ${plural(limit.data, "line")}` : ""
      }`;
    }
    case "write":
      return `${text(a.path)} · ${plural(lines(text(a.content)).length, "line")}`;
    case "edit": {
      const edits = Edits.safeParse(a.edits);
      return `${text(a.path)} · ${plural(edits.success ? edits.data.length : 1, "change")}`;
    }
    default:
      return JSON.stringify(a).slice(0, TITLE_CHARS);
  }
}

/** The arguments worth reading beyond the title, colored like a diff for `edit`. */
export function toolArgs(tool: Tool): Styled[] {
  const a = tool.args;
  switch (tool.name) {
    case "bash": {
      const command = lines(text(a.command));
      return command.length > 1 ? command.map((l) => ({ text: `$ ${l}`, fg: color.info })) : [];
    }
    case "read":
      return [];
    case "write":
      return lines(text(a.content)).map((l) => ({ text: `+ ${l}`, fg: color.ok }));
    case "edit": {
      const edits = Edits.safeParse(a.edits);
      if (!edits.success) return [];
      return edits.data.flatMap((edit, i) => [
        ...(i > 0 ? [{ text: "  ⋯", fg: color.faint }] : []),
        ...lines(edit.oldText).map((l) => ({ text: `- ${l}`, fg: color.danger })),
        ...lines(edit.newText).map((l) => ({ text: `+ ${l}`, fg: color.ok })),
      ]);
    }
    default:
      return Object.entries(a).map(([key, value]) => ({
        text: `${key}: ${text(value)}`,
        fg: color.muted,
      }));
  }
}

export function outputLines(tool: Tool) {
  return lines(tool.output);
}

/** Right-hand status of a call: its state, then its duration once finished. */
export function toolStatus(tool: Tool, now: number): Styled {
  const seconds = (to: number) =>
    tool.startedAt ? `${((to - tool.startedAt) / MS_PER_SECOND).toFixed(1)}s` : "";
  switch (tool.status) {
    case "streaming":
      return { text: "writing…", fg: color.warn };
    case "pending":
      return { text: "queued", fg: color.muted };
    case "running":
      return { text: `running ${seconds(now)}`, fg: color.warn };
    case "done":
      return { text: `✓ ${seconds(tool.endedAt ?? now)}`, fg: color.ok };
    case "error":
      return { text: "✗ failed", fg: color.danger };
  }
}

const glyphs = new Map([
  ["bash", "$"],
  ["read", "◇"],
  ["write", "✎"],
  ["edit", "±"],
]);
export const glyphOf = (name: string) => glyphs.get(name) ?? "·";
