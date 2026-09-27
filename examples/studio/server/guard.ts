/**
 * What studio checks in the changes of a harness's turn before anything is built: where
 * it wrote, and what the code imports (docs/studio/SPEC.md, 5.5, layer 2). A first,
 * readable refusal ("components/Chart.tsx imports lodash, not in the allowed packages")
 * the harness can act on; the preview's sandbox stays the real barrier, since a static
 * scan cannot see `require(name)` built at run time or `globalThis["Bun"]`.
 */
import { builtinModules } from "node:module";

/** Where generated code lives: the template's four folders, TypeScript only. */
const WRITABLE = /^(app|components|server|actions)\/[\w\-./[\]()]+\.(ts|tsx)$/;
/** Whether the harness may write `path` (relative to the project). */
export const writable = (path: string) => !path.includes("..") && WRITABLE.test(path);
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

/** Refusals for a change set (`path` relative to the project → new content, `null`: deleted). */
export function guard(changes: ReadonlyMap<string, string | null>): Refusal[] {
  const refusals: Refusal[] = [];
  for (const [file, content] of changes) {
    if (!writable(file)) {
      refusals.push({
        file,
        reason: `writes outside app/, components/, server/, actions/ (.ts, .tsx): ${file}`,
      });
      continue;
    }
    if (content === null) continue;
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
      // Before the built-ins: Bun lists its own modules (bun:sqlite) among them.
      if (path.startsWith("bun:")) {
        if (!BUN_MODULES.has(path)) refusals.push({ file, reason: `imports ${path}` });
        continue;
      }
      const bare = path.replace(/^node:/, "");
      if (BUILTINS.has(bare) || path.startsWith("node:")) {
        if (!HARMLESS.has(bare.split("/")[0] ?? ""))
          refusals.push({
            file,
            reason: `imports ${path}: needs a capability the app does not declare`,
          });
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
