// Under Bun, for the probe: the module bytes from disk (a browser passes a URL).
globalThis.OPENTUI_WASM = await Bun.file(
  process.env.OPENTUI_WASM_PATH ?? "opentui.wasm",
).arrayBuffer();
