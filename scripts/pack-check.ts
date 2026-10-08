/**
 * Proves a workspace package packs into a tarball a consumer can install and import.
 *
 *   bun scripts/pack-check.ts <package-dir>...      e.g. packages/flow-graph packages/markdown-editor
 *
 * For each directory: `bun pm pack` into a temporary directory (which runs `prepack`),
 * then fails unless
 *   - the tarball's package.json holds no `workspace:` or `catalog:` spec;
 *   - every target of `exports` (`*` patterns expanded, `null` exclusions applied; one
 *     matching nothing fails), `types`, `main` and `bin` exists in the tarball;
 *   - the tarball holds no test (a `test/` directory an export points into is the package's own
 *     API, not one) and nothing outside `files` (paths, directories, globs and
 *     `!` exclusions; package.json, README and LICENSE aside);
 *   - the tarball installs in a temporary project (with the peers, and the tarballs of the
 *     workspace packages it depends on, which no registry holds before their release) and
 *     every export imports, once under `node` and once under `bun`, every public subpath
 *     (JSON ones with import attributes); an export no import can load fails rather than
 *     being skipped. A package whose `engines` names bun and not node (it ships TypeScript
 *     sources) is imported under bun only; an export that needs the `react-server`
 *     condition is imported with it.
 * Prints one line per check and exits 0 when every package passes, 1 otherwise.
 * Installing reaches the npm registry for the package's own dependencies.
 *
 * `checkPackage` is exported so a test (or another script) can call it.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import { z } from "zod";

const Specs = z.record(z.string(), z.string()).optional();
// The fields this script reads; the rest of a package.json passes through untouched.
const Fields = z.looseObject({
  files: z.array(z.string()).optional(),
  dependencies: Specs,
  devDependencies: Specs,
  peerDependencies: Specs,
  optionalDependencies: Specs,
  engines: Specs,
});
const Manifest = Fields.extend({ name: z.string() });
type Json = z.infer<typeof Fields>;

// Async on purpose: Bun 1.4.2's spawnSync loses child exits (bun#34069).
async function run(cmd: string[], cwd: string): Promise<{ code: number; out: string }> {
  const child = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: process.env });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, out: (out + err).trim() };
}

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

/** The unresolved specs (`workspace:`, `catalog:`) of a manifest. */
export function unresolvedSpecs(manifest: Json): string[] {
  const found: string[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (/^(workspace|catalog):/.test(spec)) found.push(`${field}.${name}: ${spec}`);
    }
  }
  return found;
}

/** Every file path `types`, `main`, `module` and `bin` point at. */
export function fieldTargets(manifest: Json): string[] {
  const targets: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") targets.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(manifest.bin);
  for (const field of ["types", "typings", "main", "module"]) walk(manifest[field]);
  return targets;
}

// What React throws on a Server Components module imported without the condition.
const REACT_SERVER = /"react-server" condition must be enabled/;

// What `import()` can load: scripts and JSON. A declaration file is not one.
const IMPORTABLE = /(?<!\.d)\.(m?[jt]sx?|c[jt]s|json)$/;

/** The leaf strings of an `exports` value, conditions and arrays flattened (null skipped). */
function leaves(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(leaves);
  if (value && typeof value === "object") return Object.values(value).flatMap(leaves);
  return [];
}

export type ExportMap = {
  /** Public subpath (`.`, `./x`) to the concrete files it can resolve to, wildcards expanded. */
  subpaths: Map<string, string[]>;
  /** Targets that match no file of the tarball. */
  problems: string[];
};

/** Whether the `exports` key `key` (a subpath or a `*` pattern) covers the subpath `sub`. */
function keyMatches(key: string, sub: string): boolean {
  if (!key.includes("*")) return key === sub;
  const star = key.indexOf("*");
  const prefix = key.slice(0, star);
  const suffix = key.slice(star + 1);
  return sub.length >= key.length && sub.startsWith(prefix) && sub.endsWith(suffix);
}

/**
 * The key Node resolves `sub` with: the exact key if there is one, else the matching
 * pattern with the longest prefix (then the longest key). A `null` target on that key
 * excludes the subpath, whatever less specific pattern would map it.
 */
function governingKey(keys: readonly string[], sub: string): string | undefined {
  if (keys.includes(sub)) return sub;
  let best: string | undefined;
  for (const key of keys) {
    if (!key.includes("*") || !keyMatches(key, sub)) continue;
    const better =
      best === undefined ||
      key.indexOf("*") > best.indexOf("*") ||
      (key.indexOf("*") === best.indexOf("*") && key.length > best.length);
    if (better) best = key;
  }
  return best;
}

/**
 * The public subpaths of `exports` and their target files, with each `*` pattern expanded
 * against the tarball's `entries`; a target that matches nothing is a problem. A subpath
 * that a more specific key (a `null` exclusion above all) governs is not expanded from the
 * pattern, since Node would not resolve it through that pattern.
 */
export function resolveExports(manifest: Json, entries: readonly string[]): ExportMap {
  const subpaths = new Map<string, string[]>();
  const problems: string[] = [];
  const raw = manifest.exports;
  const isMap =
    raw !== null &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    Object.keys(raw).some((key) => key.startsWith("."));
  const map: Record<string, unknown> = isMap
    ? Object.fromEntries(Object.entries(raw))
    : raw === undefined
      ? typeof manifest.main === "string"
        ? { ".": manifest.main }
        : {}
      : { ".": raw };
  const present = new Set(entries.map((entry) => normalize(entry)));
  const keys = Object.keys(map);
  for (const [key, value] of Object.entries(map)) {
    for (const leaf of leaves(value)) {
      const target = normalize(leaf);
      if (!key.includes("*") && !target.includes("*")) {
        if (!present.has(target)) problems.push(`target ${leaf} (${key}) is not in the tarball`);
        subpaths.set(key, [...(subpaths.get(key) ?? []), target]);
        continue;
      }
      const star = target.indexOf("*");
      const pattern = new RegExp(
        `^${target
          .split("*")
          .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join("(.*)")}$`,
      );
      let matched = false;
      for (const entry of present) {
        const hit = star === -1 ? null : pattern.exec(entry);
        if (!hit) continue;
        matched = true;
        const sub = key.split("*").join(hit[1] ?? "");
        if (governingKey(keys, sub) !== key) continue;
        subpaths.set(sub, [...(subpaths.get(sub) ?? []), entry]);
      }
      if (!matched) problems.push(`pattern ${leaf} (${key}) matches nothing in the tarball`);
    }
  }
  return { subpaths, problems };
}

function matchesPattern(entry: string, pattern: string): boolean {
  const clean = normalize(pattern.replace(/^\//, "")).replace(/\/$/, "");
  return (
    entry === clean ||
    entry.startsWith(`${clean}/`) ||
    new Bun.Glob(clean).match(entry) ||
    new Bun.Glob(`${clean}/**`).match(entry)
  );
}

/** Whether npm's `files` (paths, directories, globs, `!` exclusions) lets `entry` in. */
export function inFiles(entry: string, files: readonly string[]): boolean {
  const positive = files.filter((f) => !f.startsWith("!"));
  const negative = files.filter((f) => f.startsWith("!")).map((f) => f.slice(1));
  return (
    positive.some((f) => matchesPattern(entry, f)) &&
    !negative.some((f) => matchesPattern(entry, f))
  );
}

/** `bun pm pack` of `dir` into `destination`: the tarball's path, or the failure's output. */
async function pack(
  dir: string,
  destination: string,
): Promise<{ tarball: string } | { out: string }> {
  mkdirSync(destination, { recursive: true });
  const packed = await run(["bun", "pm", "pack", "--destination", destination, "--quiet"], dir);
  const name = readdirSync(destination).find((entry) => entry.endsWith(".tgz"));
  return packed.code === 0 && name ? { tarball: join(destination, name) } : { out: packed.out };
}

/** The package directory `name` resolves to from `from`, through `node_modules`. */
function workspaceDir(name: string, from: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * Tarballs of the workspace packages `dir` depends on (`workspace:` specs), by name,
 * transitively: the tarball's manifest asks for their released version, which npm does not
 * have yet.
 */
async function workspaceTarballs(
  dir: string,
  temp: string,
  found: Map<string, string> = new Map(),
): Promise<Map<string, string>> {
  const source = Fields.parse(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")));
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
    for (const [name, spec] of Object.entries(source[field] ?? {})) {
      const home = spec.startsWith("workspace:") ? workspaceDir(name, dir) : undefined;
      if (!home || found.has(name)) continue;
      const packed = await pack(home, join(temp, "workspace", String(found.size)));
      if ("out" in packed) throw new Error(`bun pm pack of ${name} failed: ${packed.out}`);
      found.set(name, packed.tarball);
      await workspaceTarballs(home, temp, found);
    }
  }
  return found;
}

/** What is wrong with the package at `dir`; empty when it packs, installs and imports. */
export async function checkPackage(dir: string, log: (line: string) => void): Promise<string[]> {
  const problems: string[] = [];
  const temp = mkdtempSync(join(tmpdir(), "pack-check-"));
  try {
    const packed = await pack(resolve(dir), join(temp, "self"));
    if ("out" in packed) return [`bun pm pack failed: ${packed.out}`];
    const tarPath = packed.tarball;
    const tarball = tarPath.slice(tarPath.lastIndexOf("/") + 1);
    const listing = await run(["tar", "-tzf", tarPath], temp);
    const entries = listing.out
      .split("\n")
      .map((entry) => entry.replace(/^package\//, ""))
      .filter((entry) => entry && !entry.endsWith("/"));
    const extract = join(temp, "extract");
    mkdirSync(extract);
    await run(["tar", "-xzf", tarPath, "-C", extract], temp);
    const manifest = Manifest.parse(
      JSON.parse(readFileSync(join(extract, "package/package.json"), "utf8")),
    );
    const name = manifest.name;

    for (const spec of unresolvedSpecs(manifest)) problems.push(`unresolved spec ${spec}`);

    const exported = resolveExports(manifest, entries);
    problems.push(...exported.problems);
    const present = new Set(entries.map((entry) => normalize(entry)));
    for (const target of fieldTargets(manifest)) {
      if (!present.has(normalize(target))) problems.push(`target ${target} is not in the tarball`);
    }

    const files = manifest.files ?? [];
    const always =
      /^(package\.json|readme(\.[a-z]+)?|licen[cs]e(\.[a-z]+)?|changelog(\.[a-z]+)?)$/i;
    for (const entry of entries) {
      // A directory named `test` is the package's own API (`@luciole-sh/core/test`) when an
      // export points into it; a file named `.test.` or `.spec.` is a test whatever holds it.
      const testDirectory = /^(.*?(?:^|\/)(?:tests?|__tests__))\//.exec(entry)?.[1];
      const exportedDirectory =
        testDirectory !== undefined &&
        [...exported.subpaths.values()].some((targets) =>
          targets.some((target) => target.startsWith(`${testDirectory}/`)),
        );
      if (
        /(^|\/)[^/]*\.(test|spec)\.[^/]+$/.test(entry) ||
        (testDirectory !== undefined && !exportedDirectory)
      )
        problems.push(`test in the tarball: ${entry}`);
      if (!inFiles(entry, files) && !always.test(entry)) problems.push(`outside files: ${entry}`);
    }
    log(`${name}: tarball ${tarball}, ${entries.length} files`);
    if (problems.length > 0) return problems;

    // A consumer's project: the tarball plus the peers, at the ranges the package asks for.
    const consumer = join(temp, "consumer");
    mkdirSync(consumer);
    const peers = manifest.peerDependencies ?? {};
    const local = Object.fromEntries(
      [...(await workspaceTarballs(resolve(dir), temp))].map(([dep, path]) => [
        dep,
        `file:${path}`,
      ]),
    );
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({
        name: "consumer",
        private: true,
        dependencies: { ...peers, ...local, [name]: `file:${tarPath}` },
        overrides: local,
      }),
    );
    const installed = await run(["bun", "install"], consumer);
    if (installed.code !== 0) return [`install failed: ${installed.out}`];
    // `engines` naming bun and not node: TypeScript sources only bun loads.
    const nodeAllowed =
      !manifest.engines || "node" in manifest.engines || !("bun" in manifest.engines);
    for (const [sub, targets] of exported.subpaths) {
      const importable = targets.filter((target) => IMPORTABLE.test(target));
      if (importable.length === 0) {
        problems.push(`export ${sub} points at no file import() can load: ${targets.join(", ")}`);
        continue;
      }
      const specifier = sub === "." ? name : `${name}/${sub.slice(2)}`;
      const json = importable.every((target) => target.endsWith(".json"));
      const code = `await import(${JSON.stringify(specifier)}${json ? ', { with: { type: "json" } }' : ""})`;
      for (const runtime of nodeAllowed ? ["node", "bun"] : ["bun"]) {
        const args =
          runtime === "node" ? ["node", "--input-type=module", "-e", code] : ["bun", "-e", code];
        let imported = await run(args, consumer);
        if (runtime === "bun" && imported.code !== 0 && REACT_SERVER.test(imported.out))
          imported = await run(["bun", "--conditions=react-server", "-e", code], consumer);
        if (imported.code !== 0)
          problems.push(`import ${specifier} under ${runtime}: ${imported.out}`);
        else log(`${name}: import ${specifier} under ${runtime} ok`);
      }
    }
    return problems;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) {
    console.error("usage: bun scripts/pack-check.ts <package-dir>...");
    process.exit(2);
  }
  let failed = false;
  for (const dir of dirs) {
    const problems = await checkPackage(dir, console.log);
    for (const problem of problems) console.error(`${dir}: ${problem}`);
    console.log(`${dir}: ${problems.length === 0 ? "ok" : "FAILED"}`);
    if (problems.length > 0) failed = true;
  }
  process.exit(failed ? 1 : 0);
}
