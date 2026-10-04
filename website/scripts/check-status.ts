/**
 * The check that /status/ shows the versions the repository has, run on dist/ after
 * `astro build`: a version the page shows that differs from the file it names fails the build.
 *   bun scripts/check-status.ts [dist]
 *
 * The page marks each version it shows with where it comes from, in `data-version-of`:
 * `<span data-version-of="catalog:react abi:react">19.3.0</span>`. Every source a mark names
 * must hold the text shown:
 *   - `catalog:<name>`, the workspace catalog of the root package.json, which new starters copy;
 *   - `abi:<name>`, `ABI_PACKAGES` of packages/core/src/abi.ts;
 *   - `core:<name>`, the range packages/core/package.json publishes, among its dependencies
 *     or its peer dependencies;
 *   - `engines:bun`, the lowest Bun that manifest's `engines` accepts (`>=x.y.z`);
 *   - `bun-version`, the Bun CI runs, in .bun-version.
 * A version in the page's `main` that no mark holds fails too, as does a page with no mark: the
 * check would read nothing.
 *
 * It compares values, not history: a change that bumps a dependency fails the build until
 * /status/ shows the new version, which is when someone reads the page again.
 */
/// <reference types="bun" />

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

/** The files the page's versions come from, as text, so that a test can hand in a copy. */
export interface RepositoryFiles {
  /** The root package.json. */
  workspace: string;
  /** packages/core/package.json. */
  core: string;
  /** packages/core/src/abi.ts. */
  abi: string;
  /** .bun-version. */
  bunVersion: string;
}

export const FILES = {
  workspace: "package.json",
  core: "packages/core/package.json",
  abi: "packages/core/src/abi.ts",
  bunVersion: ".bun-version",
} as const satisfies Record<keyof RepositoryFiles, string>;

export const readRepository = (root: string): RepositoryFiles => ({
  workspace: readFileSync(join(root, FILES.workspace), "utf8"),
  core: readFileSync(join(root, FILES.core), "utf8"),
  abi: readFileSync(join(root, FILES.abi), "utf8"),
  bunVersion: readFileSync(join(root, FILES.bunVersion), "utf8"),
});

const Versions = z.record(z.string(), z.string());
const Workspace = z.looseObject({ workspaces: z.looseObject({ catalog: Versions }) });
const Core = z.looseObject({
  dependencies: Versions.default({}),
  peerDependencies: Versions.default({}),
  engines: z.looseObject({ bun: z.string() }),
});

/**
 * `ABI_PACKAGES` of abi.ts, read as text: importing the module would need the root install
 * (zod/mini), which a build of the website alone does not have.
 */
function abiPackages(source: string) {
  const block = /export const ABI_PACKAGES = \{([^}]*)\}/.exec(source)?.[1];
  if (block === undefined) throw new Error(`${FILES.abi}: no \`export const ABI_PACKAGES = {…}\``);
  return Object.fromEntries(
    [...block.matchAll(/^\s*(?:"([^"]+)"|([\w$]+)):\s*"([^"]+)"/gm)].map(
      ([, quoted, bare, version]) => [quoted ?? bare, version],
    ),
  );
}

/** A version the page may show: its value, and the file and field that hold it. */
export interface Source {
  version: string;
  field: string;
}

/** Every version a mark may name, by its name in `data-version-of`. */
export function versionsOf(files: RepositoryFiles): Map<string, Source> {
  const sources = new Map<string, Source>();
  const add = (kind: string, versions: Record<string, string>, field: (name: string) => string) => {
    for (const [name, version] of Object.entries(versions))
      sources.set(`${kind}:${name}`, { version, field: field(name) });
  };
  const workspace = Workspace.parse(JSON.parse(files.workspace));
  add("catalog", workspace.workspaces.catalog, (name) => `${FILES.workspace}, catalog.${name}`);
  add("abi", abiPackages(files.abi), (name) => `${FILES.abi}, ABI_PACKAGES.${name}`);
  const core = Core.parse(JSON.parse(files.core));
  add("core", core.peerDependencies, (name) => `${FILES.core}, peerDependencies.${name}`);
  add("core", core.dependencies, (name) => `${FILES.core}, dependencies.${name}`);
  const lowest = /^>=\s*(\S+)$/.exec(core.engines.bun)?.[1];
  if (!lowest)
    throw new Error(`${FILES.core}: engines.bun is "${core.engines.bun}", not ">=x.y.z"`);
  sources.set("engines:bun", { version: lowest, field: `${FILES.core}, engines.bun` });
  sources.set("bun-version", { version: files.bunVersion.trim(), field: FILES.bunVersion });
  return sources;
}

/** A version number as a reader sees one, ranges' digits included: 19.3.0, 1.170.38. */
const VERSION = /\d+\.\d+\.\d+/g;

/**
 * What the page's HTML shows that the repository does not hold, one line each, and how many
 * marks it checked.
 */
export async function statusProblems(html: string, sources: ReadonlyMap<string, Source>) {
  const marks: { names: string[]; text: string }[] = [];
  let mark: { names: string[]; text: string } | undefined;
  let unmarked = "";
  let raw = 0;
  const problems: string[] = [];
  await new HTMLRewriter()
    .on("main [data-version-of]", {
      element(element) {
        const names = (element.getAttribute("data-version-of") ?? "").split(/\s+/).filter(Boolean);
        if (mark) problems.push(`a mark inside the mark of ${mark.names.join(" ")}`);
        const opened = { names, text: "" };
        mark = opened;
        unmarked += "\n";
        element.onEndTag(() => {
          marks.push(opened);
          mark = undefined;
        });
      },
    })
    .on("main script, main style", {
      element(element) {
        raw++;
        element.onEndTag(() => void raw--);
      },
    })
    .on("main", {
      text(chunk) {
        if (raw > 0) return;
        if (mark) mark.text += chunk.text;
        else unmarked += chunk.text;
      },
    })
    .transform(new Response(html))
    .text();

  for (const { names, text } of marks) {
    const shown = text.trim();
    if (names.length === 0) problems.push(`${shown}: data-version-of names no source`);
    for (const name of names) {
      const source = sources.get(name);
      if (!source) problems.push(`${shown}: ${name} is no version of the repository`);
      else if (source.version !== shown)
        problems.push(`shows ${shown} for ${name}, but ${source.field} is ${source.version}`);
    }
  }
  for (const [version] of unmarked.matchAll(VERSION))
    problems.push(`shows ${version} with no data-version-of: nothing says where it comes from`);
  if (marks.length === 0) problems.push("no version marked with data-version-of: nothing checked");
  return { problems, checked: marks.length };
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..", "..");
  const page = join(resolve(process.argv[2] ?? "dist"), "status", "index.html");
  const { problems, checked } = await statusProblems(
    readFileSync(page, "utf8"),
    versionsOf(readRepository(root)),
  );
  if (problems.length > 0) {
    console.error(
      `check-status: ${problems.length} problem${problems.length === 1 ? "" : "s"} on /status/\n`,
    );
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(`check-status: the ${checked} versions /status/ shows match the repository.`);
}
