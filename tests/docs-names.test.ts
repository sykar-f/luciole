import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");

/** The package is `@luciole-sh/core`; its entries are `@luciole-sh/core/<entry>`. */
const OLD_NAMES: [string, RegExp][] = [
  [
    "bare `luciole/<entry>` specifier",
    // `.luciole/client` (the build directory) is legitimate, hence the `.`.
    /(?<![@/\w.-])luciole\/(client|server|dev|args|build|tsconfig|grammars|math|sandbox|pty|metadata|route-tree)\b/,
  ],
  ["`@luciole/…` scope", /@luciole\//],
  ["`packages/luciole/` directory", /packages\/luciole\//],
];

/**
 * Files that still print an old name because another mission fixes them in
 * the same wave. Each entry names the mission that removes it; delete the
 * entry with that mission.
 */
const ALLOWED = new Set<string>([
  // The French guide leaves the public site once its content is ported to
  // /docs (a later mission); its pages are not edited before then.
  "website/src/pages/guide/build.astro", // mission: guide removal (after the /docs port)
  "website/src/pages/guide/demarrage.astro", // mission: guide removal (after the /docs port)
  "website/src/pages/guide/distribution.astro", // mission: guide removal (after the /docs port)
  "website/src/pages/guide/navigation.astro", // mission: guide removal (after the /docs port)
  // Recorded terminal screens (generated frames), not authored names.
  "website/src/frames/files.json", // mission: re-record the frames (none yet)
  "website/src/frames/mux.json", // mission: re-record the frames (none yet)
]);

const TEXT = /\.(mdx?|astro|tsx?|json|css|html)$/;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name === "dist" || name === ".astro") return [];
    return statSync(path).isDirectory() ? walk(path) : TEXT.test(name) ? [path] : [];
  });

const readmes = (parent: string): string[] =>
  readdirSync(join(root, parent), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, parent, entry.name, "README.md"))
    .filter((path) => Bun.file(path).size > 0);

const files = [
  ...walk(join(root, "website/src")),
  join(root, "README.md"),
  ...readmes("packages"),
  ...readmes("examples"),
];

/** The first line of `text` that prints an old name, if any. */
export function findOldName(text: string): string | undefined {
  for (const [label, pattern] of OLD_NAMES) {
    const line = text.split("\n").findIndex((l) => pattern.test(l));
    if (line >= 0) return `${label} (line ${line + 1})`;
  }
  return undefined;
}

test("the detector flags old names and spares legitimate ones", () => {
  expect(findOldName('import { x } from "luciole/client";')).toContain("luciole/<entry>");
  expect(findOldName("extending `luciole/tsconfig`")).toBeDefined();
  expect(findOldName("`@luciole/editor`")).toContain("@luciole/");
  expect(findOldName("see packages/luciole/src")).toContain("packages/luciole");
  expect(findOldName('from "@luciole-sh/core/client"')).toBeUndefined();
  expect(findOldName("`.luciole/client` and `.luciole/server`")).toBeUndefined();
  expect(findOldName("`.luciole/metadata.json`, $XDG_DATA_HOME/luciole/apps/")).toBeUndefined();
});

test("docs, site and READMEs print only names a reader can install and import", () => {
  const found = files
    .map((path) => [relative(root, path), findOldName(readFileSync(path, "utf8"))] as const)
    .filter(([path, hit]) => hit && !ALLOWED.has(path))
    .map(([path, hit]) => `${path}: ${hit}`);
  expect(found).toEqual([]);
});

test("every allowlisted file still needs its entry", () => {
  const stale = [...ALLOWED].filter((path) => {
    const text = readFileSync(join(root, path), "utf8");
    return findOldName(text) === undefined;
  });
  expect(stale).toEqual([]);
});
