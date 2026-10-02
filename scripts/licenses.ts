import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import parseSpdx from "spdx-expression-parse";
import { z } from "zod";

// Licence check over everything the published packages ship: the production
// dependency tree (dependencies, optionalDependencies and peerDependencies, at
// every level) of each shipped package, read from the installed
// `node_modules/**/package.json`. Exits non-zero when a blocking licence (GPL,
// AGPL, SSPL, missing, "SEE LICENSE IN", unparsable) sits in one of those trees,
// or when the tree cannot be proven complete: a required dependency that does not
// resolve is an error, not a skip. Optional dependencies that are absent (other
// platforms' binaries) are reported as such. Private workspaces (harness, desktop,
// examples) are listed apart as non-shipped and never fail the check.
//
//   bun scripts/licenses.ts [--root DIR] [--ship PKG_DIR]... [--other PKG_DIR]...

export type Kind = "permissive" | "notice" | "blocking";

export interface Row {
  name: string;
  version: string;
  license: string;
  kind: Kind;
}

export interface Report {
  dir: string;
  name: string;
  rows: Row[];
  /** Optional dependencies that are not installed here. */
  absent: string[];
  /** Required dependencies (or peers) that do not resolve: the tree is incomplete. */
  unresolved: string[];
}

const PERMISSIVE = new Set(
  [
    "MIT",
    "MIT-0",
    "ISC",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "Apache-2.0",
    "0BSD",
    "Unlicense",
    "CC0-1.0",
    "BlueOak-1.0.0",
    "Python-2.0",
    "CC-BY-4.0",
  ].map((id) => id.toLowerCase()),
);
const NOTICE = /^(mpl-|lgpl-)/i;

const Manifest = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
  license: z.unknown().optional(),
  licenses: z.unknown().optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
  peerDependenciesMeta: z
    .record(z.string(), z.object({ optional: z.boolean().optional() }))
    .optional(),
});
type Manifest = z.infer<typeof Manifest>;
const TypedLicense = z.object({ type: z.string() });

function readManifest(dir: string): Manifest | undefined {
  const file = join(dir, "package.json");
  return existsSync(file) ? Manifest.parse(JSON.parse(readFileSync(file, "utf8"))) : undefined;
}

/** The licence text of a manifest, whatever legacy shape it uses; "" when absent. */
export function licenseOf(manifest: Manifest): string {
  const one = (value: unknown): string => {
    if (typeof value === "string") return value;
    const typed = TypedLicense.safeParse(value);
    return typed.success ? typed.data.type : "";
  };
  if (Array.isArray(manifest.licenses)) {
    const all = manifest.licenses.map(one).filter(Boolean);
    return all.length ? `(${all.join(" OR ")})` : "";
  }
  return one(manifest.license) || one(manifest.licenses);
}

type Expression = ReturnType<typeof parseSpdx>;

function kindOfLicense(id: string): Kind {
  if (PERMISSIVE.has(id.toLowerCase())) return "permissive";
  return NOTICE.test(id) ? "notice" : "blocking";
}

const rank: Record<Kind, number> = { permissive: 0, notice: 1, blocking: 2 };

function kindOfExpression(tree: Expression): Kind {
  if ("license" in tree) return tree.plus ? "blocking" : kindOfLicense(tree.license);
  const left = kindOfExpression(tree.left);
  const right = kindOfExpression(tree.right);
  // OR: one acceptable branch is enough, the licensee picks it. AND: every branch applies.
  const [best, worst] = rank[left] <= rank[right] ? [left, right] : [right, left];
  return tree.conjunction === "or" ? best : worst;
}

/** Classifies an SPDX expression; anything missing or unparsable is blocking. */
export function classify(expression: string): Kind {
  const text = expression.trim();
  if (!text || /^see license/i.test(text)) return "blocking";
  try {
    return kindOfExpression(parseSpdx(text));
  } catch {
    return "blocking";
  }
}

/** Node resolution of a dependency's package directory, from `from` upward. */
function resolveDependency(name: string, from: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    if (dirname(dir) === dir) return undefined;
  }
}

/** The production tree of one package directory, as one row per name@version. */
export function scanPackage(dir: string): Report {
  const start = realpathSync(dir);
  const root = readManifest(start);
  if (!root) throw new Error(`no package.json in ${dir}`);
  const rows = new Map<string, Row>();
  const absent = new Set<string>();
  const unresolved = new Set<string>();
  const seen = new Set<string>([start]);
  const visit = (pkgDir: string, manifest: Manifest): void => {
    const edges: [string, "required" | "optional"][] = [
      ...Object.keys(manifest.dependencies ?? {}).map((n): [string, "required"] => [n, "required"]),
      ...Object.keys(manifest.optionalDependencies ?? {}).map((n): [string, "optional"] => [
        n,
        "optional",
      ]),
      ...Object.keys(manifest.peerDependencies ?? {}).map(
        (n): [string, "required" | "optional"] => [
          n,
          manifest.peerDependenciesMeta?.[n]?.optional ? "optional" : "required",
        ],
      ),
    ];
    for (const [name, need] of edges) {
      const found = resolveDependency(name, pkgDir);
      if (!found) {
        (need === "optional" ? absent : unresolved).add(
          `${name} (from ${manifest.name ?? pkgDir})`,
        );
        continue;
      }
      if (seen.has(found)) continue;
      seen.add(found);
      const child = readManifest(found);
      if (!child) continue;
      const license = licenseOf(child);
      rows.set(`${child.name ?? name}@${child.version ?? "?"}`, {
        name: child.name ?? name,
        version: child.version ?? "?",
        license: license || "(none)",
        kind: classify(license),
      });
      visit(found, child);
    }
  };
  visit(start, root);
  return {
    dir,
    name: root.name ?? dir,
    rows: [...rows.values()].sort((a, b) => a.name.localeCompare(b.name)),
    absent: [...absent].sort(),
    unresolved: [...unresolved].sort(),
  };
}

function table(rows: Row[]): string {
  const label = (row: Row): string => `${row.name}@${row.version}`;
  const widthName = Math.max("package".length, ...rows.map((r) => label(r).length));
  const widthLicense = Math.max("license".length, ...rows.map((r) => r.license.length));
  const line = (a: string, b: string, c: string): string =>
    `  ${a.padEnd(widthName)}  ${b.padEnd(widthLicense)}  ${c}`;
  return [
    line("package", "license", "class"),
    ...rows.map((r) => line(label(r), r.license, r.kind)),
  ].join("\n");
}

export interface Result {
  code: number;
  output: string;
}

export function run(root: string, shipped: string[], others: string[]): Result {
  const out: string[] = [];
  const failures: string[] = [];
  const shippedKeys = new Set<string>();
  for (const dir of shipped) {
    const report = scanPackage(join(root, dir));
    out.push(`${report.name} (shipped): ${report.rows.length} packages`);
    out.push(table(report.rows));
    const byParent = new Map<string, string[]>();
    for (const item of report.absent) {
      const [name = "", parent = ""] = item.split(" (from ");
      byParent.set(parent, [...(byParent.get(parent) ?? []), name]);
    }
    for (const [parent, names] of byParent)
      out.push(`  absent optional, from ${parent.replace(/\)$/, "")}: ${names.join(", ")}`);
    for (const item of report.unresolved) failures.push(`${report.name}: unresolved ${item}`);
    for (const row of report.rows) {
      shippedKeys.add(`${row.name}@${row.version}`);
      if (row.kind === "blocking")
        failures.push(`${report.name}: ${row.name}@${row.version} ${row.license}`);
    }
    out.push("");
  }
  const workspaceNames = new Set(
    others.map((dir) => readManifest(join(root, dir))?.name).filter((n) => n !== undefined),
  );
  const apart = new Map<string, Row & { by: string[] }>();
  for (const dir of others) {
    if (shipped.includes(dir) || !existsSync(join(root, dir, "package.json"))) continue;
    const report = scanPackage(join(root, dir));
    for (const row of report.rows) {
      const key = `${row.name}@${row.version}`;
      if (row.kind === "permissive" || shippedKeys.has(key) || workspaceNames.has(row.name))
        continue;
      const known = apart.get(key) ?? { ...row, by: [] };
      known.by.push(report.name);
      apart.set(key, known);
    }
  }
  out.push("non-shipped (private workspaces, never fail the check):");
  if (!apart.size) out.push("  none");
  for (const row of [...apart.values()].sort((a, b) => a.name.localeCompare(b.name)))
    out.push(`  ${row.name}@${row.version}  ${row.license}  ${row.kind}  via ${row.by.join(", ")}`);
  out.push("");
  out.push(
    failures.length
      ? `FAIL: ${failures.length} problem(s) in shipped trees`
      : "OK: no blocking licence in a shipped tree",
  );
  for (const failure of failures) out.push(`  ${failure}`);
  return { code: failures.length ? 1 : 0, output: out.join("\n") };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let root = process.cwd();
  const ship: string[] = [];
  const other: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const value = args[i + 1] ?? "";
    if (args[i] === "--root") root = resolve(value);
    else if (args[i] === "--ship") ship.push(value);
    else if (args[i] === "--other") other.push(value);
    else continue;
    i++;
  }
  const shipped = ship.length
    ? ship
    : ["packages/core", "packages/flow-graph", "packages/markdown-editor"];
  const others = other.length
    ? other
    : ["packages", "examples"].flatMap((group) =>
        existsSync(join(root, group))
          ? readdirSync(join(root, group)).map((name) => `${group}/${name}`)
          : [],
      );
  const result = run(root, shipped, others);
  console.log(result.output);
  process.exit(result.code);
}
