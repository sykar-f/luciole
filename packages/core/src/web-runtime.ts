/**
 * The web runtime of this runtime ABI (docs/WEB.md, W8 and decision 4), prepared once per
 * framework in `$XDG_CACHE_HOME/luciole/web/<abi>-<framework>/` and copied by `luciole build
 * --web`: OpenTUI's sources at the version the ABI pins, patched for WebAssembly
 * (`web/opentui-*.patch`), its core built with Zig into opentui.wasm, and the page bundled
 * against them (src/web/build.ts).
 *
 * The first preparation needs the network (git) and Zig at the version OpenTUI requires;
 * the next ones reuse the cache. The entry appears in one rename: an interrupted build
 * leaves nothing behind.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ABI_KEY, APP_MANIFEST, AppManifest } from "./abi";
import { defaultCache } from "./targets";
import { frameworkHash } from "./framework-hash";
import { buildWebRuntime, TREE_SITTER_DIRECTORY, WEB_RUNTIME_FILES } from "./web/build";
import { WEB_SERVER_FILE } from "./web/server-build";
import {
  OPENTUI_TAG,
  OPENTUI_REPOSITORY,
  OPENTUI_PATCH,
  PIXEL_SCROLL_PATCH,
  prepareOpenTuiCheckout,
  buildOpenTuiLibrary,
  publishRuntimeEntry,
} from "./opentui-runtime";
export { prepareOpenTuiCheckout } from "./opentui-runtime";

/** Source cache identity includes both ordered OpenTUI patches. */
export function openTuiCheckoutDirectory(cache = defaultCache()) {
  const key = createHash("sha256")
    .update(readFileSync(OPENTUI_PATCH))
    .update(readFileSync(PIXEL_SCROLL_PATCH))
    .digest("hex")
    .slice(0, HASH_PREFIX);
  return join(cache, "web", `opentui-${OPENTUI_TAG}-${key}`);
}
const HASH_PREFIX = 16;
/** One entry per ABI key and framework: the page is the framework's code too. */
export const webRuntimeDirectory = async (cache = defaultCache()) =>
  join(cache, "web", `${ABI_KEY}-${(await frameworkHash()).slice(0, HASH_PREFIX)}`);

const openTuiPatches = (patch: string) =>
  patch === OPENTUI_PATCH ? [patch, PIXEL_SCROLL_PATCH] : [patch];

/** OpenTUI's sources at a tag, patched, with opentui.wasm built. Defaults to the ABI pin. */
export function prepareOpenTui(
  checkout: string,
  zig: string,
  { tag = OPENTUI_TAG, patch = OPENTUI_PATCH }: { tag?: string; patch?: string } = {},
) {
  const tree = prepareOpenTuiCheckout(checkout, OPENTUI_REPOSITORY, tag, openTuiPatches(patch));
  return buildOpenTuiLibrary({
    checkout,
    zig,
    tree,
    artifact: join(checkout, "packages/native/lib/wasm32-wasi/opentui.wasm"),
    options: ["-Dlibrary-target=wasm32-wasi", "-Doptimize=ReleaseSmall"],
    runtime: "web runtime",
  });
}

const runtimeComplete = (directory: string) =>
  [...WEB_RUNTIME_FILES, "runtime.js.map", "web-runtime.json", TREE_SITTER_DIRECTORY].every(
    (file) => existsSync(join(directory, file)),
  );

/** Internal preparation seam; the lock covers the shared checkout and runtime publication. */
export async function prepareWebRuntimeEntry(options: {
  directory: string;
  checkout: string;
  build: (temporary: string) => Promise<void>;
  waiting?: () => void;
  sourceTree?: () => string;
}) {
  return publishRuntimeEntry({ ...options, marker: "web-runtime.json", complete: runtimeComplete });
}

/** This ABI's web runtime, built on first use; its directory. */
export async function prepareWebRuntime({
  cache = defaultCache(),
  zig = process.env["ZIG"] ?? "zig",
}: { cache?: string; zig?: string } = {}) {
  const directory = await webRuntimeDirectory(cache);
  // A patch revision needs a clean source checkout; applying it over an older
  // patched tree can neither pass the reverse check nor apply the new patch.
  const checkout = openTuiCheckoutDirectory(cache);
  return prepareWebRuntimeEntry({
    directory,
    checkout,
    sourceTree: () =>
      prepareOpenTuiCheckout(
        checkout,
        OPENTUI_REPOSITORY,
        OPENTUI_TAG,
        openTuiPatches(OPENTUI_PATCH),
      ),
    waiting: () =>
      console.error(`luciole web-runtime: waiting for another preparation of ${directory}`),
    async build(temporary) {
      const wasm = prepareOpenTui(checkout, zig);
      await buildWebRuntime({ checkout, wasm, outdir: temporary });
    },
  });
}

const copy = (from: string, to: string, names: readonly string[]) =>
  Promise.all(names.map((name) => Bun.write(join(to, name), Bun.file(join(from, name)))));

/**
 * Copies this ABI's web runtime next to a build's other outputs (`<output>/web`). `local`:
 * a static site instead, with the in-browser Server (`web-server/`) and the application
 * bundle (`app/`) beside the page, which it tells to use them.
 */
export async function installWebRuntime(
  output: string,
  { local = false, ...options }: { local?: boolean; cache?: string; zig?: string } = {},
) {
  const source = await prepareWebRuntime(options);
  const target = join(output, "web");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(join(target, "app"), { recursive: true });
  await copy(source, target, [...WEB_RUNTIME_FILES, "runtime.js.map", "web-runtime.json"]);
  cpSync(join(source, TREE_SITTER_DIRECTORY), join(target, TREE_SITTER_DIRECTORY), {
    recursive: true,
  });
  if (!local) return target;
  await copy(join(output, "web-server"), target, [
    WEB_SERVER_FILE,
    `${WEB_SERVER_FILE}.map`,
    "sqlite3.wasm",
  ]);
  const manifest = AppManifest.parse(
    JSON.parse(readFileSync(join(output, "app", APP_MANIFEST), "utf8")),
  );
  await copy(join(output, "app"), join(target, "app"), [APP_MANIFEST, manifest.bundle]);
  const page = readFileSync(join(source, "index.html"), "utf8");
  const marked = page.replace(
    '<div id="luciole"></div>',
    '<div id="luciole" data-server="worker"></div>',
  );
  if (marked === page) throw new Error(`${source}/index.html has no #luciole element to mark`);
  writeFileSync(join(target, "index.html"), marked);
  return target;
}
