/**
 * `#opentui/runtime-assets` for the browser: the native library is the `opentui.wasm`
 * that ffi-wasm.ts already instantiated; tree-sitter's Worker, wasm, parsers and queries
 * are the web runtime's `tree-sitter/` files (src/web/build.ts), next to `runtime.js`.
 */
const TREE_SITTER = new URL("tree-sitter/", import.meta.url);
const treeSitterFile = (path: string) => new URL(path, TREE_SITTER).href;

export const resolveNativeLibraryPath = async () => "opentui.wasm";
/** `relativePath` is OpenTUI's, `assets/<language>/<file>`, kept under `tree-sitter/`. */
export const resolveDefaultParserAsset = async (relativePath: string) =>
  treeSitterFile(relativePath);
export const resolveDefaultTreeSitterWorkerPath = () => treeSitterFile("parser-worker.js");
export const resolveTreeSitterWasm = async () => treeSitterFile("tree-sitter.wasm");
