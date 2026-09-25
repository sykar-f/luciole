// First module of the page: Node's globals, and where opentui.wasm is, before OpenTUI
// evaluates (its FFI module instantiates the module at load).
import "./node/process";

globalThis.OPENTUI_WASM = new URL("opentui.wasm", import.meta.url);
