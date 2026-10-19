/** Keep every OpenTUI importer on the prepared JavaScript/native pair. */
import type { BunPlugin } from "bun";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import * as z from "zod/mini";

const Export = z.union([
  z.string(),
  z.object({
    bun: z.optional(z.string()),
    import: z.optional(z.string()),
    default: z.optional(z.string()),
  }),
]);
const Manifest = z.object({ exports: z.record(z.string(), Export) });

export function nativeRuntimePlugin(directory: string): BunPlugin {
  // Bun reports real paths to onResolve, even when the cache uses a symlink.
  directory = realpathSync(directory);
  const installed = realpathSync(dirname(Bun.resolveSync("@opentui/core", import.meta.dir)));
  const prepared = join(directory, "core");
  const manifest = Manifest.parse(JSON.parse(readFileSync(join(prepared, "package.json"), "utf8")));
  function coreEntry(specifier: string) {
    const subpath =
      specifier === "@opentui/core" ? "." : `.${specifier.slice("@opentui/core".length)}`;
    const entry = manifest.exports[subpath];
    const path =
      typeof entry === "string" ? entry : (entry?.bun ?? entry?.import ?? entry?.default);
    if (!path) throw new Error(`Prepared OpenTUI has no export ${specifier}`);
    return join(prepared, path);
  }
  return {
    name: "luciole-prepared-opentui",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (/^@opentui\/core-(darwin|linux|win32)-/.test(args.path))
          return { path: join(directory, "library/index.bun.js") };
        if (args.path === "@opentui/core" || args.path.startsWith("@opentui/core/"))
          return { path: coreEntry(args.path) };
        // build.ts externalizes installed OpenTUI exports as absolute paths.
        if (isAbsolute(args.path) && args.path.startsWith(installed + "/"))
          return { path: join(prepared, relative(installed, args.path)) };
        // A cache outside node_modules must retain the installed dependency graph.
        if (
          args.importer.startsWith(prepared + "/") &&
          /^[^./]/.test(args.path) &&
          !args.path.startsWith("bun:") &&
          !args.path.startsWith("node:")
        )
          return { path: Bun.resolveSync(args.path, installed) };
        return undefined;
      });
    },
  };
}
