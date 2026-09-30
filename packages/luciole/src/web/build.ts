/**
 * Builds the web runtime (docs/WEB.md, W8): one page per runtime ABI key, not per
 * application. `runtime.js` (the framework, React, OpenTUI from its sources on
 * opentui.wasm, xterm.js), `opentui.wasm`, `xterm.css`, `index.html` and `tree-sitter/`.
 */
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { BunPlugin } from "bun";
import { ABI_KEY } from "../abi";
import { abiKeyLiteral } from "./abi-key";
import { bundleMessages, logMessages } from "../bundle-errors";
import { browserNode } from "./node/plugin";
import { opentuiWasm } from "./opentui/plugin";
import { platformVariants } from "./platform";

export const WEB_RUNTIME_FILES = ["index.html", "runtime.js", "opentui.wasm", "xterm.css"] as const;
/**
 * Syntax highlighting (`<code>`, `<diff>`, `<markdown>`): OpenTUI's tree-sitter Worker,
 * web-tree-sitter's wasm and the default parsers with their queries, fetched on demand.
 */
export const TREE_SITTER_DIRECTORY = "tree-sitter";
const require = createRequire(import.meta.url);
/** The parsers and queries OpenTUI ships, relative to its tree-sitter sources. */
const PARSER_ASSETS = /\.(wasm|scm)$/;

/**
 * OpenTUI's tree-sitter Worker for a page. OpenTUI starts it with `new Worker(url)`, a
 * classic script: an IIFE, `import.meta` replaced by the Worker's own location. Its
 * `DownloadUtils` fetches by URL instead of caching in a data directory.
 */
async function buildTreeSitter(checkout: string, outdir: string) {
  const sources = join(checkout, "packages/core/src/lib/tree-sitter");
  const failed = (messages: string) =>
    new Error(`The tree-sitter Worker failed to build:\n${messages}`);
  const downloads: BunPlugin = {
    name: "tree-sitter-downloads",
    setup(build) {
      build.onResolve({ filter: /\/download-utils(\.js)?$/ }, () => ({
        path: join(import.meta.dir, "opentui/tree-sitter-downloads.ts"),
      }));
    },
  };
  const result = await Bun.build({
    entrypoints: [join(sources, "parser.worker.ts")],
    outdir,
    naming: "parser-worker.js",
    target: "browser",
    format: "iife",
    minify: true,
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "import.meta.url": "self.location.href",
      "import.meta.resolve": "__resolveInWorker",
    },
    banner: "var __resolveInWorker = (s) => new URL(s, self.location.href).href;",
    plugins: [downloads, browserNode],
  }).catch((error: unknown) => {
    throw failed(bundleMessages(error).join("\n"));
  });
  if (!result.success) throw failed(logMessages(result.logs));
  const core = createRequire(join(checkout, "packages/core/package.json"));
  copyFileSync(core.resolve("web-tree-sitter/tree-sitter.wasm"), join(outdir, "tree-sitter.wasm"));
  for (const file of readdirSync(join(sources, "assets"), { recursive: true, encoding: "utf8" })) {
    if (!PARSER_ASSETS.test(file)) continue;
    mkdirSync(dirname(join(outdir, "assets", file)), { recursive: true });
    copyFileSync(join(sources, "assets", file), join(outdir, "assets", file));
  }
}

/** `@opentui/core` from the checkout prepare.ts made: its sources, not the npm bundle. */
const opentuiSources = (checkout: string): BunPlugin => ({
  name: "opentui-sources",
  setup(build) {
    build.onResolve({ filter: /^@opentui\/core$/ }, () => ({
      path: join(checkout, "packages/core/src/index.ts"),
    }));
  },
});

export async function buildWebRuntime({
  checkout,
  wasm,
  outdir,
}: {
  /** OpenTUI's sources at the ABI's version, patched (prepare.ts). */
  checkout: string;
  /** The opentui.wasm built from them. */
  wasm: string;
  outdir: string;
}) {
  mkdirSync(outdir, { recursive: true });
  const failed = (messages: string) => new Error(`The web runtime failed to build:\n${messages}`);
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "runtime.tsx")],
    outdir,
    naming: "runtime.js",
    target: "browser",
    format: "esm",
    minify: true,
    sourcemap: "linked",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [abiKeyLiteral, platformVariants, opentuiWasm, opentuiSources(checkout), browserNode],
  }).catch((error: unknown) => {
    throw failed(bundleMessages(error).join("\n"));
  });
  if (!result.success) throw failed(logMessages(result.logs));
  await buildTreeSitter(checkout, join(outdir, TREE_SITTER_DIRECTORY));
  copyFileSync(wasm, join(outdir, "opentui.wasm"));
  copyFileSync(require.resolve("@xterm/xterm/css/xterm.css"), join(outdir, "xterm.css"));
  copyFileSync(join(import.meta.dir, "index.html"), join(outdir, "index.html"));
  await Bun.write(
    join(outdir, "web-runtime.json"),
    `${JSON.stringify({ abi: ABI_KEY }, null, 2)}\n`,
  );
  return outdir;
}
