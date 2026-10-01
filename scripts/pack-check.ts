/**
 * Proves a workspace package packs into a tarball a consumer can install and import.
 *
 *   bun scripts/pack-check.ts <package-dir>...      e.g. packages/flow packages/editor
 *
 * For each directory: `bun pm pack` into a temporary directory (which runs `prepack`),
 * then fails unless
 *   - the tarball's package.json holds no `workspace:` or `catalog:` spec;
 *   - every target of `exports`, `types`, `main` and `bin` exists in the tarball;
 *   - the tarball holds no test and nothing outside `files` (package.json, README and
 *     LICENSE aside);
 *   - the tarball installs in a temporary project (with the peers) and every export
 *     imports, once under `node` and once under `bun`.
 * Prints one line per check and exits 0 when every package passes, 1 otherwise.
 * Installing reaches the npm registry for the package's own dependencies.
 *
 * `checkPackage` is exported so a test (or another script) can call it.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize, resolve } from "node:path";
import { z } from "zod";

const Specs = z.record(z.string(), z.string()).optional();
// The fields this script reads; the rest of a package.json passes through untouched.
const Fields = z.looseObject({
  files: z.array(z.string()).optional(),
  dependencies: Specs,
  devDependencies: Specs,
  peerDependencies: Specs,
  optionalDependencies: Specs,
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

/** Every file path an `exports` value, `types`, `main` or `bin` points at. */
export function manifestTargets(manifest: Json): string[] {
  const targets: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") targets.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(manifest.exports);
  walk(manifest.bin);
  for (const field of ["types", "typings", "main", "module"]) walk(manifest[field]);
  return targets;
}

/** The subpaths `exports` makes importable (patterns with `*` and non-JS files left out). */
export function importableSubpaths(manifest: Json): string[] {
  const exports = manifest.exports;
  if (typeof exports === "string") return ["."];
  if (!exports || typeof exports !== "object") return manifest.main ? ["."] : [];
  const keys = Object.keys(exports);
  if (!keys.some((key) => key.startsWith("."))) return ["."];
  return keys.filter((key) => !key.includes("*") && !key.endsWith(".json"));
}

/** What is wrong with the package at `dir`; empty when it packs, installs and imports. */
export async function checkPackage(dir: string, log: (line: string) => void): Promise<string[]> {
  const problems: string[] = [];
  const temp = mkdtempSync(join(tmpdir(), "pack-check-"));
  try {
    const packed = await run(["bun", "pm", "pack", "--destination", temp, "--quiet"], resolve(dir));
    const tarball = readdirSync(temp).find((name) => name.endsWith(".tgz"));
    if (packed.code !== 0 || !tarball) return [`bun pm pack failed: ${packed.out}`];
    const tarPath = join(temp, tarball);
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

    const present = new Set(entries);
    for (const target of manifestTargets(manifest)) {
      if (target.includes("*")) continue;
      if (!present.has(normalize(target))) problems.push(`target ${target} is not in the tarball`);
    }

    const files = (manifest.files ?? []).map((f) => normalize(f));
    const always =
      /^(package\.json|readme(\.[a-z]+)?|licen[cs]e(\.[a-z]+)?|changelog(\.[a-z]+)?)$/i;
    for (const entry of entries) {
      if (
        /(^|\/)[^/]*\.(test|spec)\.[^/]+$/.test(entry) ||
        /(^|\/)(tests?|__tests__)\//.test(entry)
      )
        problems.push(`test in the tarball: ${entry}`);
      const inFiles = files.some((f) => entry === f || entry.startsWith(`${f}/`));
      if (!inFiles && !always.test(entry)) problems.push(`outside files: ${entry}`);
    }
    log(`${name}: tarball ${tarball}, ${entries.length} files`);
    if (problems.length > 0) return problems;

    // A consumer's project: the tarball plus the peers, at the ranges the package asks for.
    const consumer = join(temp, "consumer");
    mkdirSync(consumer);
    const peers = manifest.peerDependencies ?? {};
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({
        name: "consumer",
        private: true,
        dependencies: { ...peers, [name]: `file:${tarPath}` },
      }),
    );
    const installed = await run(["bun", "install"], consumer);
    if (installed.code !== 0) return [`install failed: ${installed.out}`];
    for (const sub of importableSubpaths(manifest)) {
      const specifier = sub === "." ? name : `${name}/${sub.slice(2)}`;
      for (const runtime of ["node", "bun"]) {
        const code = `await import(${JSON.stringify(specifier)})`;
        const args =
          runtime === "node" ? ["node", "--input-type=module", "-e", code] : ["bun", "-e", code];
        const imported = await run(args, consumer);
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
