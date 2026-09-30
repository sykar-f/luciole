import ts from "@typescript/typescript6";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { join, relative } from "node:path";
import { z } from "zod";
import { build } from "../../packages/luciole/src/build";
import { logMessages } from "../../packages/luciole/src/bundle-errors";
import { readJsonFile } from "../../packages/luciole/src/package-json";
import { isAbiSpecifier, runtimeAbi } from "./abi";

const quote = JSON.stringify;
// The part of `.luciole/manifest.json` (src/build.ts) this bundler reads.
const BuildManifest = z.object({
  buildId: z.string(),
  manifest: z.record(z.string(), z.object({ id: z.string() })),
});
const USE_SERVER = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*["']use server["']/;
const exportsOf = (source: string) => new Bun.Transpiler({ loader: "tsx" }).scan(source).exports;

/**
 * An application's Client as the generic Client needs it: only Client Components, the
 * route tree and action stubs, every ABI specifier left to the runtime. `src/build.ts`
 * runs first for the build ID, the Client Reference ids and the Server.
 *
 * Format: Bun's `bun-cjs` wrapper, `(function (exports, require, module, …) {…})`. The
 * loader calls it with its own `require`: that table *is* the ABI, and a specifier outside
 * it fails at load time instead of reaching the host's node_modules.
 */
export async function bundleApp(appDir: string, { minify = true } = {}) {
  const started = performance.now();
  const { output } = await build(appDir);
  const serverBuildMs = performance.now() - started;
  const { buildId, manifest } = await readJsonFile(join(output, "manifest.json"), BuildManifest);
  const ids = [...new Set(Object.values(manifest).map((m) => m.id))].sort();
  const id = (file: string) => `${buildId}/${relative(appDir, file)}`;
  const entry = join(appDir, `.luciole-bundle-entry-${crypto.randomUUID()}.ts`);
  await Bun.write(
    entry,
    `export {routeTree} from ${quote(join(appDir, "app/routeTree.gen.ts"))};\n` +
      ids
        .map(
          (m, i) => `import * as C${i} from ${quote(join(appDir, m.slice(buildId.length + 1)))};`,
        )
        .join("\n") +
      `\nexport const buildId=${quote(buildId)};\nexport const modules={${ids.map((m, i) => `${quote(m)}:C${i}`).join(",")}};`,
  );
  const bundled = new Set<string>();
  try {
    const result = await Bun.build({
      entrypoints: [entry],
      format: "cjs",
      target: "bun",
      minify,
      metafile: true,
      plugins: [
        {
          name: "luciole-generic-client",
          setup(b) {
            b.onResolve({ filter: /.*/ }, (a) =>
              isAbiSpecifier(a.path) ? { path: a.path, external: true } : undefined,
            );
            b.onLoad({ filter: /\.[tj]sx?$/ }, async (a) => {
              const source = await readFile(a.path, "utf8");
              if (!a.path.includes("/node_modules/")) bundled.add(relative(appDir, a.path));
              else
                bundled.add(
                  a.path.slice(a.path.lastIndexOf("/node_modules/") + "/node_modules/".length),
                );
              // "use server" modules become references, as in src/build.ts: the Server
              // code never enters the bundle.
              const text = USE_SERVER.test(source)
                ? `import {actionReference} from "luciole/client";\n` +
                  exportsOf(source)
                    .map(
                      (n) => `export const ${n}=actionReference(${quote(`${id(a.path)}#${n}`)});`,
                    )
                    .join("\n")
                : source;
              return {
                contents: ts.transpileModule(text, {
                  fileName: a.path,
                  compilerOptions: {
                    target: ts.ScriptTarget.ESNext,
                    module: ts.ModuleKind.ESNext,
                    jsx: ts.JsxEmit.ReactJSX,
                    jsxImportSource: "@opentui/react",
                  },
                }).outputText,
                loader: "js",
              };
            });
          },
        },
      ],
    });
    if (!result.success) throw new Error(logMessages(result.logs));
    const [artifact] = result.outputs;
    if (!artifact) throw new Error("Bun.build produced no bundle");
    const code = await artifact.text();
    // What the bundle asks of its host beyond the ABI, as `require` will name them: Node
    // built-ins are capabilities (fs, child_process…) that an `inline` host grants
    // silently and a sandbox must declare. Bun externalizes them before any plugin runs,
    // so they are read from the bundler's metafile.
    const builtins = new Set<string>();
    for (const input of Object.values(result.metafile?.inputs ?? {}))
      for (const i of input.imports)
        if (i.external && !isAbiSpecifier(i.path)) {
          if (!isBuiltin(i.path)) throw new Error(`Unexpected external ${i.path}`);
          builtins.add(i.path);
        }
    return {
      buildId,
      code,
      sha256: createHash("sha256").update(code).digest("hex"),
      abi: (await runtimeAbi()).key,
      clientModules: ids.length,
      builtins: [...builtins].sort(),
      sources: bundled.size,
      serverBuildMs,
      bundleMs: performance.now() - started - serverBuildMs,
    };
  } finally {
    await rm(entry, { force: true });
  }
}
export type AppBundle = Awaited<ReturnType<typeof bundleApp>>;
