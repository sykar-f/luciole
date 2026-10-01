import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

// Licence check over everything the published packages ship: the production
// dependency tree (dependencies, optionalDependencies and the peer dependencies
// that resolve) of each shipped package, read from the installed
// `node_modules/**/package.json`. Exits non-zero when a blocking licence (GPL,
// AGPL, SSPL, missing, "SEE LICENSE IN", unknown) sits in one of those trees.
// Private workspaces (harness, desktop, examples) are listed apart as non-shipped
// and never fail the check.
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
}

const PERMISSIVE = new Set(
  [
    "MIT",
    "MIT-0",
    "ISC",
    "BSD",
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

const rank: Record<Kind, number> = { permissive: 0, notice: 1, blocking: 2 };

/** Classifies an SPDX expression: OR takes the best choice, AND the worst. */
export function classify(expression: string): Kind {
  const text = expression.trim();
  if (!text || /^see license/i.test(text) || /^unlicensed$/i.test(text)) return "blocking";
  const tokens = text.replace(/[()]/g, " ").split(/\s+/).filter(Boolean);
  // Parenthesised groups are rare; flatten with the usual precedence (AND binds tighter).
  let current: string[] = [];
  const orGroups: string[][] = [current];
  for (const token of tokens) {
    if (/^or$/i.test(token)) {
      current = [];
      orGroups.push(current);
    } else if (!/^and$/i.test(token)) current.push(token);
  }
  let best: Kind = "blocking";
  for (const group of orGroups) {
    let worst: Kind = "permissive";
    for (const id of group) {
      const kind: Kind = PERMISSIVE.has(id.toLowerCase())
        ? "permissive"
        : NOTICE.test(id)
          ? "notice"
          : "blocking";
      if (rank[kind] > rank[worst]) worst = kind;
    }
    if (rank[worst] < rank[best]) best = worst;
  }
  return best;
}

/** Node resolution of a dependency's package directory, from `from` upward. */
function resolveDependency(name: string, from: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

/** The production tree of one package directory, as one row per name@version. */
export function scanPackage(dir: string): Report {
  const root = readManifest(dir);
  if (!root) throw new Error(`no package.json in ${dir}`);
  const rows = new Map<string, Row>();
  const seen = new Set<string>();
  const visit = (pkgDir: string, manifest: Manifest, includePeers: boolean): void => {
    const names = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...(includePeers ? manifest.peerDependencies : {}),
    };
    for (const [name, range] of Object.entries(names)) {
      if (range.startsWith("workspace:")) continue;
      const found = resolveDependency(name, pkgDir);
      // Optional dependencies (other platforms' binaries) are legitimately absent.
      if (!found) continue;
      const real = resolve(found);
      if (seen.has(real)) continue;
      seen.add(real);
      const child = readManifest(real);
      if (!child) continue;
      const license = licenseOf(child);
      rows.set(`${child.name ?? name}@${child.version ?? "?"}`, {
        name: child.name ?? name,
        version: child.version ?? "?",
        license: license || "(none)",
        kind: classify(license),
      });
      visit(real, child, false);
    }
  };
  visit(resolve(dir), root, true);
  return {
    dir,
    name: root.name ?? dir,
    rows: [...rows.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function table(report: Report, only?: (row: Row) => boolean): string {
  const rows = only ? report.rows.filter(only) : report.rows;
  const width = (pick: (row: Row) => string, head: string): number =>
    Math.max(head.length, ...rows.map((row) => pick(row).length));
  const widthName = width((r) => `${r.name}@${r.version}`, "package");
  const widthLicense = width((r) => r.license, "license");
  const line = (a: string, b: string, c: string): string =>
    `  ${a.padEnd(widthName)}  ${b.padEnd(widthLicense)}  ${c}`;
  return [
    line("package", "license", "class"),
    ...rows.map((r) => line(`${r.name}@${r.version}`, r.license, r.kind)),
  ].join("\n");
}

function histogram(report: Report): string {
  const counts = new Map<string, number>();
  for (const row of report.rows) counts.set(row.license, (counts.get(row.license) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => `${id} ${n}`)
    .join(", ");
}

export interface Result {
  code: number;
  output: string;
}

export function run(root: string, shipped: string[], others: string[]): Result {
  const out: string[] = [];
  let blocking = 0;
  for (const dir of shipped) {
    const report = scanPackage(join(root, dir));
    const bad = report.rows.filter((row) => row.kind === "blocking");
    blocking += bad.length;
    out.push(`${report.name} (shipped): ${report.rows.length} packages`);
    out.push(`  ${histogram(report)}`);
    const listed = report.rows.filter((row) => row.kind !== "permissive");
    out.push(
      listed.length ? table(report, (row) => row.kind !== "permissive") : "  all permissive",
    );
    out.push("");
  }
  const shippedKeys = new Set(
    shipped.flatMap((dir) =>
      scanPackage(join(root, dir)).rows.map((r) => `${r.name}@${r.version}`),
    ),
  );
  const apart = new Map<string, Row & { by: string[] }>();
  for (const dir of others) {
    if (shipped.includes(dir) || !existsSync(join(root, dir, "package.json"))) continue;
    const report = scanPackage(join(root, dir));
    for (const row of report.rows) {
      const key = `${row.name}@${row.version}`;
      if (row.kind === "permissive" || shippedKeys.has(key)) continue;
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
    blocking
      ? `FAIL: ${blocking} blocking licence(s) in a shipped tree`
      : "OK: no blocking licence in a shipped tree",
  );
  if (blocking)
    for (const dir of shipped)
      for (const row of scanPackage(join(root, dir)).rows)
        if (row.kind === "blocking")
          out.push(`  ${dir}: ${row.name}@${row.version} ${row.license}`);
  return { code: blocking ? 1 : 0, output: out.join("\n") };
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
  const shipped = ship.length ? ship : ["packages/luciole", "packages/flow", "packages/editor"];
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
