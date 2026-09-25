/**
 * What src/build.ts adds to the Server's build when it also targets the browser (`airtty
 * build --web=local`, docs/WEB.md W8): a first module that prepares the Worker, the plugins
 * that give the Server's code a browser platform, and the files the Worker loads next to
 * itself. Bun-side only: nothing here runs in the page.
 */
import type { BunPlugin } from "bun";
import { copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { abiKeyLiteral } from "./abi-key";
import { browserNode } from "./node/plugin";
import { platformVariants } from "./platform";

export { transformAsyncContext } from "./async-context/transform";

/** Imported before the application's Server entry. */
export const WEB_SERVER_SETUP = join(import.meta.dir, "server/setup.ts");
export const WEB_SERVER_FILE = "server-worker.js";
const require = createRequire(import.meta.url);

/** `bun:sqlite` and `node:async_hooks` as the Worker provides them. */
const serverModules: BunPlugin = {
  name: "airtty-web-server-modules",
  setup(build) {
    build.onResolve({ filter: /^bun:sqlite$/ }, () => ({
      path: join(import.meta.dir, "node/bun-sqlite.ts"),
    }));
    build.onResolve({ filter: /^(node:)?async_hooks$/ }, () => ({
      path: join(import.meta.dir, "async-context/storage.ts"),
    }));
  },
};

/** Before the build's own plugin: the first to resolve or load a module wins. */
export const webServerPlugins = [abiKeyLiteral, platformVariants, serverModules, browserNode];

/** SQLite's module, which its loader fetches next to the script that bundled it. */
export function copyWebServerFiles(outdir: string) {
  copyFileSync(
    require.resolve("@sqlite.org/sqlite-wasm/sqlite3.wasm"),
    join(outdir, "sqlite3.wasm"),
  );
}
