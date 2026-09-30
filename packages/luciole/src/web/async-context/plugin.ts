/**
 * Bun.build plugin for a Server bundle that runs without engine async context:
 * `node:async_hooks` is async-context.ts, and every module is rewritten by transform.ts.
 */
import type { BunPlugin } from "bun";
import { join } from "node:path";
import { transformAsyncContext } from "./transform";

const RUNTIME = join(import.meta.dir, "storage.ts");
const loaderOf = (path: string) =>
  path.endsWith(".tsx")
    ? "tsx"
    : path.endsWith(".ts")
      ? "ts"
      : path.endsWith(".jsx")
        ? "jsx"
        : "js";

export const asyncContext = ({ transform = true } = {}): BunPlugin => ({
  name: "async-context",
  setup(build) {
    build.onResolve({ filter: /^(node:)?async_hooks$/ }, () => ({ path: RUNTIME }));
    if (!transform) return;
    build.onLoad({ filter: /\.(ts|tsx|js|mjs|cjs|jsx)$/ }, async (args) => {
      if (args.path === RUNTIME) return undefined;
      return {
        loader: loaderOf(args.path),
        contents: transformAsyncContext(await Bun.file(args.path).text(), args.path),
      };
    });
  },
});
