import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// The Troubleshooting page quotes messages so that a reader can search for them. A message
// the page attributes to luciole must be in the sources as written, or the reader searches
// for words the program never prints. Messages from Bun or macOS are not ours to check.
const root = resolve(import.meta.dir, "..");
const PAGE = "website/src/content/docs/reference/troubleshooting.mdx";
const ORIGIN = /\b(luciole|Bun|macOS) (?:prints|shows|reports)\b/;
const PARTS = ["**Cause:**", "**Fix:**", "**Check:**"];

export interface Entry {
  heading: string;
  /** Who prints the message, as the sentence before it says. */
  origin: string | undefined;
  /** The lines of the message block. */
  message: string[];
  missing: string[];
}

/** The `###` entries of the page: the symptom, the message, then cause, fix and check. */
export function entriesOf(page: string): Entry[] {
  return page
    .split(/^### /m)
    .slice(1)
    .map((section) => {
      const [heading = "", ...rest] = section.split("\n");
      const body = rest.join("\n");
      const block = /^```text\n([\s\S]*?)\n```$/m.exec(body);
      const before = block
        ? body
            .slice(0, block.index)
            .trim()
            .split(/\n\s*\n/)
            .at(-1)
        : "";
      return {
        heading,
        origin: ORIGIN.exec(before?.replaceAll("\n", " ") ?? "")?.[1],
        message: block?.[1]?.split("\n").filter((line) => line.trim()) ?? [],
        missing: PARTS.filter((part) => !body.includes(part)),
      };
    });
}

/**
 * The sources as one text, with a string split by `+` joined back: a message written over
 * two literals reads as one.
 */
export const joinLiterals = (source: string) => source.replace(/["'`]\s*\+\s*["'`]/g, "");

/** A quoted line as a pattern: `<name>` stands for one `${…}` of a template literal. */
export function patternOf(line: string): RegExp {
  const parts = line.split(/<[^<>]+>/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(parts.join("\\$\\{[^}]*\\}"));
}

/** The lines the page attributes to luciole that no source holds. */
export function unquoted(entries: readonly Entry[], sources: string): string[] {
  return entries
    .filter((entry) => entry.origin === "luciole")
    .flatMap((entry) => entry.message)
    .filter((line) => !patternOf(line).test(sources));
}

const sources = () =>
  joinLiterals(
    [...new Bun.Glob("packages/*/src/**/*.{ts,tsx}").scanSync({ cwd: root })]
      .toSorted()
      .map((path) => readFileSync(join(root, path), "utf8"))
      .join("\n"),
  );

describe("the Troubleshooting page", () => {
  const entries = entriesOf(readFileSync(join(root, PAGE), "utf8"));

  test("has at least twelve entries, each with its message, cause, fix and check", () => {
    expect(entries.length).toBeGreaterThanOrEqual(12);
    const incomplete = entries
      .filter((entry) => !entry.origin || !entry.message.length || entry.missing.length)
      .map((entry) => entry.heading);
    expect(incomplete).toEqual([]);
  });

  test("quotes luciole's messages as the sources write them", () => {
    expect(unquoted(entries, sources())).toEqual([]);
  });
});

describe("the check of a quoted message", () => {
  const source = joinLiterals(
    [
      'throw new Error(`Cannot create the starter: ${command.join(" ")} exited ${code}`);',
      'throw new Error(`${target}: not a path (start it with ./), ` +\n  "or a Server URL");',
    ].join("\n"),
  );
  const entry = (message: string[], origin = "luciole"): Entry => ({
    heading: "h",
    origin,
    message,
    missing: [],
  });

  test("finds a message with its placeholders, also over two literals", () => {
    const quoted = [
      "Cannot create the starter: <command> exited <code>",
      "<target>: not a path (start it with ./), or a Server URL",
    ];
    expect(unquoted([entry(quoted)], source)).toEqual([]);
  });

  test("reports a changed word, and leaves other programs' messages alone", () => {
    const changed = "Cannot create the starter: <command> failed with <code>";
    expect(unquoted([entry([changed])], source)).toEqual([changed]);
    expect(unquoted([entry([changed], "Bun")], source)).toEqual([]);
  });

  test("reads the origin from the sentence before the message", () => {
    const page = [
      "### A symptom",
      "",
      "You ran `bunx luciole.sh init`, and",
      "Bun prints:",
      "",
      "```text",
      "Failed",
      "```",
      "",
      "- **Cause:** c",
      "- **Fix:** f",
    ].join("\n");
    expect(entriesOf(page)).toEqual([
      { heading: "A symptom", origin: "Bun", message: ["Failed"], missing: ["**Check:**"] },
    ]);
  });
});
