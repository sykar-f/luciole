import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isExportDeclaration, isExportSpecifier } from "typescript/unstable/ast/is";
import { API, type Checker, type Symbol as TsSymbol, SymbolFlags } from "typescript/unstable/async";
import { z } from "zod";
import { internalExports, pendingExports } from "../website/src/lib/docs/exports";

// Every name the published packages export, runtime values and types, is documented, or
// named internal with its reason, or pending under the API family that will document it.
// The names come from the TypeScript checker: it follows `export *` and re-exports, and
// it sees the types that an `import()` of the entry cannot.
const root = join(import.meta.dir, "..");

const Exports = z.union([
  z.string(),
  z.record(z.string(), z.union([z.string(), z.record(z.string(), z.string())])),
]);
const Manifest = z.looseObject({
  name: z.string(),
  private: z.boolean().optional(),
  exports: z.record(z.string(), Exports).optional(),
});

const packages = readdirSync(join(root, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join("packages", entry.name))
  .filter((dir) => existsSync(join(root, dir, "package.json")))
  .map((dir) => ({
    dir,
    manifest: Manifest.parse(JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"))),
  }))
  .filter(({ manifest }) => manifest.private === false);

/** The source file of an entry: Bun's condition, else the declarations, else the default. */
function sourceOf(target: z.infer<typeof Exports>): string | undefined {
  if (typeof target === "string") return target;
  const picked = target.bun ?? target.types ?? target.default;
  return typeof picked === "string" ? picked : undefined;
}

/** The module entries of a package as `[import specifier, source file]`; JSON entries have no names. */
const entriesOf = ({ manifest }: (typeof packages)[number]): [string, string][] =>
  Object.entries(manifest.exports ?? {}).flatMap(([subpath, target]) => {
    const source = sourceOf(target);
    if (!source || !/\.tsx?$/.test(source)) return [];
    return [[join(manifest.name, subpath), source]];
  });

/** The pages that document a package: the reference for the framework, the README otherwise. */
function docsOf({ dir, manifest }: (typeof packages)[number]): string[] {
  if (manifest.name !== "@luciole-sh/core" && manifest.name !== "luciole.sh")
    return [join(dir, "README.md")];
  const walk = (path: string): string[] =>
    readdirSync(join(root, path), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(path, entry.name))
        : /\.mdx?$/.test(entry.name)
          ? [join(path, entry.name)]
          : [],
    );
  return walk("website/src/content/docs/reference");
}

/**
 * The code spans of a page, outside fenced blocks. A span documents the name it starts with:
 * `name`, `name(…)`, `<Name …>`, `new Name(…)`, `Name[]`.
 */
function spansOf(markdown: string): string[] {
  const prose = markdown.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "");
  return [...prose.matchAll(/(`+)(?!`)([\s\S]+?)(?<!`)\1(?!`)/g)].map((match) =>
    (match[2] ?? "").trim(),
  );
}

const documents = (spans: readonly string[], name: string) =>
  spans.some((span) => {
    const subject = span.replace(/^(<|new\s+)/, "");
    return subject.startsWith(name) && !/^[\w$]/.test(subject.slice(name.length));
  });

/** An exported name: `<import specifier>#<name>`, and whether it is a runtime value. */
interface Exported {
  key: string;
  value: boolean;
  documented: boolean;
}

interface Lists {
  internal: Readonly<Record<string, string>>;
  pending: Readonly<Record<string, readonly string[]>>;
}

/** What breaks the inventory: unclassified names, stale or contradicting entries. */
function judge(exported: readonly Exported[], { internal, pending }: Lists): string[] {
  const errors: string[] = [];
  const byKey = new Map(exported.map((name) => [name.key, name]));
  const pendingKeys = Object.entries(pending).flatMap(([family, keys]) =>
    keys.map((key) => ({ family, key })),
  );
  const listed = [...Object.keys(internal), ...pendingKeys.map(({ key }) => key)];
  for (const key of new Set(listed.filter((key, index) => listed.indexOf(key) !== index)))
    errors.push(`${key}: listed twice in exports.ts`);
  for (const [key, reason] of Object.entries(internal)) {
    if (!byKey.has(key)) errors.push(`${key}: internal, but no entry exports it`);
    else if (byKey.get(key)?.documented) errors.push(`${key}: internal, but a page documents it`);
    if (reason.trim() === "") errors.push(`${key}: internal without a reason`);
  }
  for (const { family, key } of pendingKeys) {
    if (!byKey.has(key)) errors.push(`${key}: pending (${family}), but no entry exports it`);
    else if (byKey.get(key)?.documented)
      errors.push(`${key}: documented now, remove it from pending (${family})`);
  }
  const classified = new Set(listed);
  for (const { key, value, documented } of exported)
    if (!documented && !classified.has(key))
      errors.push(
        `${key}: a ${value ? "value" : "type"} documented nowhere; document it, or list it internal or pending`,
      );
  return errors;
}

const api = new API({ cwd: root });

/** A runtime value, unless it is not one or a re-export on the way says `export type`. */
async function isValue(checker: Checker, symbol: TsSymbol): Promise<boolean> {
  let current: TsSymbol | undefined = symbol;
  while (current && current.flags & SymbolFlags.Alias) {
    for (const handle of current.declarations) {
      const node = await handle.resolve();
      if (!node || !isExportSpecifier(node)) continue;
      const declaration = node.parent.parent;
      if (node.isTypeOnly || (isExportDeclaration(declaration) && declaration.isTypeOnly))
        return false;
    }
    const next: TsSymbol | undefined = await checker.getImmediateAliasedSymbol(current);
    if (!next) return ((await checker.getAliasedSymbol(current)).flags & SymbolFlags.Value) !== 0;
    current = next;
  }
  return current !== undefined && (current.flags & SymbolFlags.Value) !== 0;
}
let exported: Exported[] = [];

/** Every name of every entry of the published packages, from the checker of each package's project. */
async function inventory(): Promise<Exported[]> {
  const projects = packages.filter((pkg) => entriesOf(pkg).length > 0);
  const snapshot = await api.updateSnapshot({
    openProjects: projects.map(({ dir }) => join(root, dir, "tsconfig.json")),
  });
  const names: Exported[] = [];
  for (const pkg of projects) {
    const project = snapshot.getProject(join(root, pkg.dir, "tsconfig.json"));
    if (!project) throw new Error(`${pkg.dir}/tsconfig.json: no project`);
    const spans = docsOf(pkg).flatMap((path) => spansOf(readFileSync(join(root, path), "utf8")));
    for (const [specifier, source] of entriesOf(pkg)) {
      const file = await project.program.getSourceFile(join(root, pkg.dir, source));
      const module = file && (await project.checker.getSymbolAtLocation(file));
      if (!module) throw new Error(`${specifier}: ${source} is not in ${pkg.dir}'s project`);
      // `export type * from` hands over the module's own symbols, not aliases: the names it
      // brings are types for the importer, even a function's.
      const typeOnly = new Set<string>();
      for (const statement of file.statements) {
        if (!isExportDeclaration(statement) || !statement.isTypeOnly || statement.exportClause)
          continue;
        const from =
          statement.moduleSpecifier &&
          (await project.checker.getSymbolAtLocation(statement.moduleSpecifier));
        for (const symbol of from ? await project.checker.getExportsOfModule(from) : [])
          typeOnly.add(symbol.name);
      }
      for (const symbol of await project.checker.getExportsOfModule(module)) {
        const starred = !(symbol.flags & SymbolFlags.Alias) && typeOnly.has(symbol.name);
        names.push({
          key: `${specifier}#${symbol.name}`,
          value: !starred && (await isValue(project.checker, symbol)),
          documented: documents(spans, symbol.name),
        });
      }
    }
  }
  return names;
}

beforeAll(async () => {
  exported = await inventory();
});

afterAll(async () => {
  await api.close();
});

describe("the published exports", () => {
  test("are the entries of the five published packages", () => {
    expect(packages.map(({ manifest }) => manifest.name).toSorted()).toEqual([
      "@luciole-sh/core",
      "@luciole-sh/create",
      "@luciole-sh/flow-graph",
      "@luciole-sh/markdown-editor",
      "luciole.sh",
    ]);
    // Values and types of every entry, read from the sources.
    expect(exported.some(({ key, value }) => key === "@luciole-sh/core/client#run" && value)).toBe(
      true,
    );
    expect(exported.some(({ key, value }) => key === "@luciole-sh/flow-graph#Node" && !value)).toBe(
      true,
    );
    // A schema re-exported with `export type`, a function under `export type *`: types only.
    expect(
      exported.some(({ key, value }) => key === "@luciole-sh/core/client#HostEvent" && !value),
    ).toBe(true);
    expect(
      exported.some(({ key, value }) => key === "@luciole-sh/markdown-editor#isText" && !value),
    ).toBe(true);
  });

  test("are each documented, internal or pending", () => {
    expect(judge(exported, { internal: internalExports, pending: pendingExports })).toEqual([]);
  });
});

describe("the inventory", () => {
  const name = (key: string, { documented = false, value = true } = {}): Exported => ({
    key,
    value,
    documented,
  });
  const none: Lists = { internal: {}, pending: {} };

  test("fails on a name documented nowhere and listed nowhere", () => {
    expect(judge([name("pkg#added")], none)).toEqual([
      "pkg#added: a value documented nowhere; document it, or list it internal or pending",
    ]);
    expect(judge([name("pkg#Shape", { value: false })], none)).toEqual([
      "pkg#Shape: a type documented nowhere; document it, or list it internal or pending",
    ]);
    expect(judge([name("pkg#added", { documented: true })], none)).toEqual([]);
  });

  test("fails on a pending name that a page now documents", () => {
    const pending = { client: ["pkg#useThing"] };
    expect(judge([name("pkg#useThing")], { internal: {}, pending })).toEqual([]);
    expect(judge([name("pkg#useThing", { documented: true })], { internal: {}, pending })).toEqual([
      "pkg#useThing: documented now, remove it from pending (client)",
    ]);
  });

  test("fails on stale, contradicting, doubled or unexplained entries", () => {
    expect(judge([], { internal: { "pkg#gone": "a reason" }, pending: {} })).toEqual([
      "pkg#gone: internal, but no entry exports it",
    ]);
    expect(judge([], { internal: {}, pending: { client: ["pkg#gone"] } })).toEqual([
      "pkg#gone: pending (client), but no entry exports it",
    ]);
    expect(
      judge([name("pkg#a", { documented: true })], {
        internal: { "pkg#a": "a reason" },
        pending: {},
      }),
    ).toEqual(["pkg#a: internal, but a page documents it"]);
    expect(judge([name("pkg#a")], { internal: { "pkg#a": " " }, pending: {} })).toEqual([
      "pkg#a: internal without a reason",
    ]);
    expect(
      judge([name("pkg#a")], { internal: { "pkg#a": "a reason" }, pending: { client: ["pkg#a"] } }),
    ).toEqual(["pkg#a: listed twice in exports.ts"]);
  });

  test("reads a name as documented when a code span starts with it", () => {
    const spans = spansOf(
      [
        "| `useFlow()` | `<Flow nodes />` | `new EditorController(markdown?)` | `Node[]` |",
        "`run` and `bun run dev` and `useFlowState`",
        "```ts",
        'import { fitViewport } from "@luciole-sh/flow-graph";',
        "```",
      ].join("\n"),
    );
    for (const documented of ["useFlow", "Flow", "EditorController", "Node", "run"])
      expect(documents(spans, documented)).toBe(true);
    for (const undocumented of ["fitViewport", "useFlowStat", "dev", "Edge"])
      expect(documents(spans, undocumented)).toBe(false);
  });
});
