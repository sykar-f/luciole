/**
 * Builds the web runtime (docs/WEB.md, W8): one page per runtime ABI key, not per
 * application. `runtime.js` (the framework, React, OpenTUI from its sources on
 * opentui.wasm, xterm.js), `opentui.wasm`, `xterm.css` and `index.html`.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { BunPlugin } from "bun";
import { ABI_KEY } from "../abi";
import { bundleMessages, logMessages } from "../bundle-errors";
import { browserNode } from "./node/plugin";
import { opentuiWasm } from "./opentui/plugin";
import { platformVariants } from "./platform";

export const WEB_RUNTIME_FILES = ["index.html", "runtime.js", "opentui.wasm", "xterm.css"] as const;
const require = createRequire(import.meta.url);

/**
 * src/abi.ts with its key written in: the page cannot hash synchronously, and the key is
 * this build's anyway. Fails the build if the expression it replaces changed.
 */
const abiKeyLiteral: BunPlugin = {
  name: "airtty-abi-key",
  setup(build) {
    build.onLoad({ filter: /\/src\/abi\.ts$/ }, async (args) => {
      const text = await Bun.file(args.path).text();
      const next = text
        .replace(
          /export const ABI_KEY = `\$\{ABI_VERSION\}-\$\{createHash\([\s\S]*?\.slice\(0, KEY_HEX\)\}`;/,
          `export const ABI_KEY = ${JSON.stringify(ABI_KEY)};`,
        )
        .replace('import { createHash } from "node:crypto";\n', "");
      if (next.includes("createHash"))
        throw new Error(`${args.path}: the ABI key is no longer computed as expected`);
      return { loader: "ts", contents: next };
    });
  },
};

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
  copyFileSync(wasm, join(outdir, "opentui.wasm"));
  copyFileSync(require.resolve("@xterm/xterm/css/xterm.css"), join(outdir, "xterm.css"));
  copyFileSync(join(import.meta.dir, "index.html"), join(outdir, "index.html"));
  await Bun.write(
    join(outdir, "web-runtime.json"),
    `${JSON.stringify({ abi: ABI_KEY }, null, 2)}\n`,
  );
  return outdir;
}
