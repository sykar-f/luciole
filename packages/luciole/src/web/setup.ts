// First module of the page: Node's globals, and where opentui.wasm and the tree-sitter
// Worker are, before OpenTUI evaluates (its FFI module instantiates the module at load).
import "./node/process";

globalThis.OPENTUI_WASM = new URL("opentui.wasm", import.meta.url);
// OpenTUI reads this before looking for its Worker on disk, where a page finds nothing.
Object.defineProperty(globalThis, "OTUI_TREE_SITTER_WORKER_PATH", {
  value: new URL("tree-sitter/parser-worker.js", import.meta.url).href,
});
