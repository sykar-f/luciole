// In a page, before OpenTUI loads: a `process` global, and the module next to the bundle,
// fetched by ffi-wasm.ts.
import "./browser-node/process";

globalThis.OPENTUI_WASM = new URL("opentui.wasm", import.meta.url);
