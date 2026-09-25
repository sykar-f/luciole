/**
 * Builds a probe entry against @opentui/core's sources and opentui.wasm.
 *   bun build.ts <entry> <out-dir> [bun|browser]
 * OPENTUI_SRC: the OpenTUI checkout at the version the ABI pins (v0.5.12).
 */
import { join, resolve } from "node:path";
import { browserNode, opentuiWasm } from "./plugin";

const [entry, outdir, targetArgument = "bun"] = process.argv.slice(2);
const target = targetArgument === "browser" ? "browser" : "bun";
if (targetArgument !== target) throw new Error(`unknown target ${targetArgument}: bun or browser`);
const source = process.env.OPENTUI_SRC;
if (!entry || !outdir || !source)
  throw new Error("usage: OPENTUI_SRC=… bun build.ts <entry> <out-dir> [bun|browser]");
const core = join(resolve(source), "packages/core/src/index.ts");
const result = await Bun.build({
  entrypoints: [entry],
  outdir,
  target,
  format: "esm",
  sourcemap: "linked",
  plugins: [
    opentuiWasm,
    ...(target === "browser" ? [browserNode] : []),
    {
      name: "opentui-source",
      setup(b) {
        b.onResolve({ filter: /^@opentui\/core$/ }, () => ({ path: core }));
      },
    },
  ],
});
for (const log of result.logs) console.error(log);
if (!result.success) process.exit(1);
for (const output of result.outputs) console.log(output.path, output.size);
