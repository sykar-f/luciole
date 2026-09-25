/**
 * Node built-ins in a page (docs/WEB.md, § 4): what OpenTUI and the runtime import that
 * Bun's browser polyfills lack, and what stands for each. `events`, `stream`, `buffer`,
 * `path` and `util` keep Bun's polyfills.
 */
import type { BunPlugin } from "bun";
import { join } from "node:path";

const SHIMS = import.meta.dir;
/** Node built-ins with no useful browser polyfill, and what stands for each in a page. */
const BROWSER_NODE: Record<string, string> = {
  fs: "fs.ts",
  "fs/promises": "fs-promises.ts",
  url: "url.ts",
  os: "os.ts",
  module: "unavailable.ts",
  worker_threads: "unavailable.ts",
  child_process: "unavailable.ts",
  tty: "unavailable.ts",
  perf_hooks: "perf-hooks.ts",
  console: "console.ts",
  crypto: "crypto.ts",
};
export const browserNode: BunPlugin = {
  name: "browser-node",
  setup(build) {
    build.onResolve(
      {
        filter:
          /^(node:)?(fs|fs\/promises|url|os|module|worker_threads|child_process|tty|perf_hooks|console|crypto)$/,
      },
      (args) => {
        const shim = BROWSER_NODE[args.path.replace(/^node:/, "")];
        return shim ? { path: join(SHIMS, shim) } : undefined;
      },
    );
  },
};
