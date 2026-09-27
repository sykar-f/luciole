/**
 * What studio checks in a harness's change set before it reaches the workspace's build:
 * where it writes, and what the code imports. A first, readable refusal ("components/
 * Chart.tsx imports lodash, not in the allowed packages") that the harness can act on;
 * the OS sandbox of the preview (probes/studio-server-sandbox) stays the real barrier,
 * since a static scan cannot see `require(name)` built at run time or `Bun.spawn`.
 */
import { builtinModules } from "node:module";

/** Where generated code lives: the template's four folders, TypeScript only. */
const WRITABLE = /^(app|components|server|actions)\/[\w\-./[\]()]+\.(ts|tsx)$/;
/** Written by the build: a harness that edits it fights the build. */
const GENERATED = new Set(["app/routeTree.gen.ts"]);
/** The packages the template installs: nothing else resolves in the workspace. */
const PACKAGES = new Set([
  "airtty/client",
  "airtty/server",
  "react",
  "@opentui/core",
  "@opentui/react",
  "@tanstack/react-router",
  "zod",
]);
/** Built-ins that do not reach outside the process: the rest needs a capability. */
const HARMLESS = new Set(["crypto", "path", "url", "util", "events", "buffer"]);
const BUILTINS = new Set(builtinModules);
/** Bun's own modules: `bun:sqlite` is the template's database, the rest is refused. */
const BUN_MODULES = new Set(["bun:sqlite"]);
/** Globals that start programs or open raw sockets: named in the refusal. */
const DANGEROUS_CALLS =
  /\bBun\.(spawn|spawnSync|connect|listen|serve|udpSocket|\$)\b|\beval\(|new Function\(/;

export type Refusal = { file: string; reason: string };

const transpilers = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
};
/** A specifier's package: `@scope/name/sub` → `@scope/name/sub` if listed, else its root. */
function packageOf(specifier: string) {
  if (PACKAGES.has(specifier)) return specifier;
  const parts = specifier.split("/");
  const root = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? "");
  return root;
}

/** Refusals for a change set (`path` relative to the workspace → new content). */
export function guard(changes: ReadonlyMap<string, string>): Refusal[] {
  const refusals: Refusal[] = [];
  for (const [file, content] of changes) {
    if (file.includes("..") || !WRITABLE.test(file) || GENERATED.has(file)) {
      refusals.push({
        file,
        reason: `writes outside app/, components/, server/, actions/ (.ts, .tsx): ${file}`,
      });
      continue;
    }
    const transpiler = file.endsWith(".tsx") ? transpilers.tsx : transpilers.ts;
    let imports: { path: string }[];
    try {
      imports = transpiler.scanImports(content);
    } catch {
      // A syntax error: the build reports it.
      continue;
    }
    for (const { path } of imports) {
      if (path.startsWith(".")) continue;
      const bare = path.replace(/^node:/, "");
      if (BUILTINS.has(bare) || path.startsWith("node:")) {
        if (!HARMLESS.has(bare.split("/")[0] ?? ""))
          refusals.push({
            file,
            reason: `imports ${path}: needs a capability the app does not declare`,
          });
        continue;
      }
      if (path.startsWith("bun:")) {
        if (!BUN_MODULES.has(path)) refusals.push({ file, reason: `imports ${path}` });
        continue;
      }
      const name = packageOf(path);
      if (!PACKAGES.has(name) && !PACKAGES.has(path))
        refusals.push({ file, reason: `imports ${path}, not in the allowed packages` });
    }
    const call = DANGEROUS_CALLS.exec(content);
    if (call) refusals.push({ file, reason: `calls ${call[0]}` });
  }
  return refusals;
}
