/**
 * `#opentui/runtime-assets` for the browser: the native library is the `opentui.wasm`
 * that ffi-wasm.ts already instantiated; tree-sitter is out of the spike (docs/WEB.md, R1).
 */
const unavailable = (what: string) => () => {
  throw new Error(`${what} is not available in the browser runtime yet`);
};
export const resolveNativeLibraryPath = async () => "opentui.wasm";
export const resolveDefaultParserAsset = unavailable("tree-sitter");
export const resolveDefaultTreeSitterWorkerPath = unavailable("tree-sitter");
export const resolveTreeSitterWasm = unavailable("tree-sitter");
