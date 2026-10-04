import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  GRAMMAR_PACKAGES,
  WEB_RUNTIME_PACKAGES,
  WEB_SERVER_PACKAGES,
} from "../packages/core/src/optional";

// The Optional packages page gives, for each optional feature of @luciole-sh/core, the
// packages an app installs and the command that installs them. A package added to a feature
// without its row and its word in the command would stop a build on a name no page gives,
// and a package the page lists that the feature does not need would be installed for nothing.
const root = resolve(import.meta.dir, "..");
const PAGE = "website/src/content/docs/reference/optional-packages.mdx";
const TROUBLESHOOTING = "website/src/content/docs/reference/troubleshooting.mdx";
const LINK = "/docs/reference/optional-packages/";
const read = (path: string) => readFileSync(join(root, path), "utf8");

const manifest = z
  .object({
    peerDependencies: z.record(z.string(), z.string()),
    peerDependenciesMeta: z.record(z.string(), z.object({ optional: z.boolean().optional() })),
  })
  .parse(JSON.parse(read("packages/core/package.json")));
const listed = new Set<string>([
  ...GRAMMAR_PACKAGES,
  ...WEB_RUNTIME_PACKAGES,
  ...WEB_SERVER_PACKAGES,
]);
/** Core's optional peers that no list of optional.ts holds: those of `@luciole-sh/core/math`. */
const MATH_PACKAGES = Object.entries(manifest.peerDependenciesMeta)
  .filter(([name, meta]) => meta.optional && !listed.has(name))
  .map(([name]) => name);

interface Family {
  /** The heading of its section, and the anchor the summary table links to. */
  heading: string;
  anchor: string;
  packages: readonly string[];
}

const FAMILIES: readonly Family[] = [
  {
    heading: "Highlight more languages: grammars",
    anchor: "highlight-more-languages-grammars",
    packages: GRAMMAR_PACKAGES,
  },
  {
    heading: "Draw display math: math",
    anchor: "draw-display-math-math",
    packages: MATH_PACKAGES,
  },
  {
    heading: "Build for the browser: web runtime",
    anchor: "build-for-the-browser-web-runtime",
    packages: WEB_RUNTIME_PACKAGES,
  },
  {
    heading: "Run the Server in the browser: SQLite WASM",
    anchor: "run-the-server-in-the-browser-sqlite-wasm",
    packages: WEB_SERVER_PACKAGES,
  },
];

interface Section {
  /** The packages of its `bun add` commands, in order. */
  command: string[];
  /** The packages of its table's first column, with their version cell. */
  rows: Map<string, string>;
}

/** The `## ` sections of the page, by heading. */
export function sectionsOf(page: string): Map<string, Section> {
  return new Map(
    page
      .split(/^## /m)
      .slice(1)
      .map((section) => {
        const [heading = "", ...rest] = section.split("\n");
        const body = rest.join("\n");
        const command = [...body.matchAll(/"bun add ([^"]+)"/g)].flatMap(([, names = ""]) =>
          names.split(/\s+/),
        );
        const rows = new Map(
          [...body.matchAll(/^\|\s*`([^`]+)`\s*\|.*\|\s*`([^`]+)`\s*\|$/gm)].map(
            ([, name = "", version = ""]) => [name, version] as const,
          ),
        );
        return [heading, { command, rows }] as const;
      }),
  );
}

const sorted = (names: Iterable<string>) => [...names].toSorted().join(" ");

/** What the page gets wrong about each family, one line per problem; empty when it is right. */
export function mismatches(
  page: string,
  families: readonly Family[],
  versions: Readonly<Record<string, string>>,
): string[] {
  const sections = sectionsOf(page);
  return families.flatMap(({ heading, packages }) => {
    const section = sections.get(heading);
    if (!section) return [`no "## ${heading}" section`];
    const problems: string[] = [];
    if (sorted(section.command) !== sorted(packages))
      problems.push(`${heading}: the command installs ${section.command.join(" ")}`);
    if (sorted(section.rows.keys()) !== sorted(packages))
      problems.push(`${heading}: the table lists ${[...section.rows.keys()].join(" ")}`);
    for (const [name, version] of section.rows)
      if (versions[name] !== undefined && versions[name] !== version)
        problems.push(`${heading}: ${name} reads ${version}, core accepts ${versions[name]}`);
    return problems;
  });
}

/** The names in `STARTER_DEPENDENCIES`, the packages a created app depends on. */
function starterDependencies() {
  const source = read("packages/create/scripts/starter.ts");
  const list = /const STARTER_DEPENDENCIES = \[([\s\S]*?)\];/.exec(source)?.[1] ?? "";
  return new Set([...list.matchAll(/"([^"]+)"/g)].map(([, name]) => name));
}

describe("the Optional packages page", () => {
  const page = read(PAGE);

  test("gives each family's packages, command and versions as core declares them", () => {
    expect(MATH_PACKAGES.length).toBeGreaterThan(0);
    expect(mismatches(page, FAMILIES, manifest.peerDependencies)).toEqual([]);
  });

  test("counts as math only the packages @luciole-sh/core/math loads", () => {
    const loaded = read("packages/core/src/math.ts").matchAll(
      /loadOptional\(\s*FEATURE,\s*"([^"]+)"/g,
    );
    expect(sorted(new Set([...loaded].map(([, name = ""]) => name)))).toBe(sorted(MATH_PACKAGES));
  });

  test("fails on a package added to a list of optional.ts", () => {
    const grown = FAMILIES.map((family) =>
      family.packages === WEB_RUNTIME_PACKAGES
        ? { ...family, packages: [...family.packages, "@xterm/addon-search"] }
        : family,
    );
    const web = "Build for the browser: web runtime";
    const current = "@xterm/xterm @xterm/addon-fit @xterm/addon-webgl";
    expect(mismatches(page, grown, manifest.peerDependencies)).toEqual([
      `${web}: the command installs ${current}`,
      `${web}: the table lists ${current}`,
    ]);
  });

  test("fails on a version core no longer accepts", () => {
    const bumped = { ...manifest.peerDependencies, "mathjax-full": "^4.0.0" };
    expect(mismatches(page, FAMILIES, bumped)).toEqual([
      "Draw display math: math: mathjax-full reads ^3.2.2, core accepts ^4.0.0",
    ]);
  });

  test("says which families the starter installs, as the starter does", () => {
    const starter = starterDependencies();
    const rows = [...page.matchAll(/^\| \[[^\]]+\]\(#([^)]+)\).*\|\s*(yes|no)\s*\|$/gm)];
    expect(rows.map(([, anchor]) => anchor)).toEqual(FAMILIES.map(({ anchor }) => anchor));
    for (const [, anchor, inStarter] of rows) {
      const family = FAMILIES.find((candidate) => candidate.anchor === anchor);
      expect(family?.packages.every((name) => starter.has(name))).toBe(inStarter === "yes");
    }
  });

  test("quotes the message luciole prints for a missing package", () => {
    // The source escapes the backticks of its template literal, and names `${name}`.
    const source = read("packages/core/src/optional.ts")
      .replaceAll("\\`", "`")
      .replaceAll(/\$\{(\w+)\}/g, "<$1>");
    const quoted = /```text\n(.*)\n```/.exec(page)?.[1] ?? "";
    expect(quoted).toContain("needs the optional package");
    expect(source).toContain(quoted);
  });
});

describe("the Troubleshooting page", () => {
  test("links each entry about a missing optional package to the Optional packages page", () => {
    const about = read(TROUBLESHOOTING)
      .split(/^### /m)
      .slice(1)
      .filter((entry) => /^```text\n[^`]*optional package/m.test(entry));
    expect(about.length).toBeGreaterThan(0);
    const unlinked = about.filter((entry) => !entry.includes(`](${LINK}`));
    expect(unlinked.map((entry) => entry.split("\n")[0])).toEqual([]);
  });
});
