import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// The Environment variables page lists every LUCIOLE_* variable the packages read: in a
// table of settings, or in the table of variables luciole sets for its own processes. A
// variable added to the sources without a row would be a setting no reader can find, and a
// row without a variable would document a setting that does nothing.
const root = resolve(import.meta.dir, "..");
const PAGE = "website/src/content/docs/reference/environment.mdx";
const INTERNAL = "Which variables luciole sets for its own processes";
// `__LUCIOLE_FIBERS__` and the like are globals, not variables: the name must stand alone.
const VARIABLE = /(?<!\w)LUCIOLE_[A-Z0-9]+(?:_[A-Z0-9]+)*(?!\w)/g;

/** The variables a text names. */
export const variablesOf = (text: string) => new Set(text.match(VARIABLE));

/** The variables in the first cell of each table row of `section`. */
const rowsOf = (section: string) =>
  section
    .split("\n")
    .map((line) => /^\|\s*`(LUCIOLE_[A-Z0-9_]+)`/.exec(line)?.[1])
    .filter((name) => name !== undefined);

/** The page's variables: those of its settings tables, and those of its internal table. */
export function tablesOf(page: string) {
  const sections = page.split(/^## /m).slice(1);
  const internal = sections.filter((section) => section.startsWith(`${INTERNAL}\n`));
  if (internal.length !== 1) throw new Error(`${PAGE} needs one "## ${INTERNAL}" section`);
  return {
    settings: new Set(sections.filter((s) => !internal.includes(s)).flatMap(rowsOf)),
    internal: new Set(internal.flatMap(rowsOf)),
  };
}

/** The variables the sources name that no table of the page lists. */
export function undocumented(read: ReadonlySet<string>, page: string) {
  const { settings, internal } = tablesOf(page);
  return [...read].filter((name) => !settings.has(name) && !internal.has(name)).toSorted();
}

const read = () =>
  variablesOf(
    [...new Bun.Glob("packages/*/src/**/*.{ts,tsx}").scanSync({ cwd: root })]
      .map((path) => readFileSync(join(root, path), "utf8"))
      .join("\n"),
  );

describe("the Environment variables page", () => {
  const page = readFileSync(join(root, PAGE), "utf8");
  const sources = read();

  test("lists every LUCIOLE_* variable the packages read", () => {
    expect(sources.size).toBeGreaterThan(30);
    expect(undocumented(sources, page)).toEqual([]);
  });

  test("lists no variable the packages do not read", () => {
    const { settings, internal } = tablesOf(page);
    expect([...settings, ...internal].filter((name) => !sources.has(name))).toEqual([]);
  });

  test("puts no variable both among the settings and the internal ones", () => {
    const { settings, internal } = tablesOf(page);
    expect([...internal].filter((name) => settings.has(name))).toEqual([]);
  });

  test("misses a variable whose row is removed, settings and internal alike", () => {
    for (const name of ["LUCIOLE_EXAMPLES_REPO", "LUCIOLE_TEST"]) {
      const without = page.replace(new RegExp(`^\\| \`${name}\`.*\\n`, "m"), "");
      expect(without).not.toBe(page);
      expect(undocumented(sources, without)).toEqual([name]);
    }
  });
});

describe("variablesOf", () => {
  test("reads the names of variables and skips globals", () => {
    const text = 'env.LUCIOLE_URL; "LUCIOLE_FAULT: bad"; globalThis.__LUCIOLE_FIBERS__';
    expect([...variablesOf(text)]).toEqual(["LUCIOLE_URL", "LUCIOLE_FAULT"]);
  });
});
