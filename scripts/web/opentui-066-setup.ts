// Test-only observation of the real FFI instance. Grow one page deterministically
// without filling the allocator's reserve or exposing memory in the production backend.
import "../../packages/core/src/web/setup";

const instantiate = WebAssembly.instantiate;
let memory: WebAssembly.Memory | undefined;
Object.assign(WebAssembly, {
  async instantiate(bytes: Uint8Array, imports?: WebAssembly.Imports) {
    const result = await instantiate(bytes, imports);
    const exported = result.instance.exports["memory"];
    if (!(exported instanceof WebAssembly.Memory)) throw new Error("Missing WASM memory");
    memory = exported;
    WebAssembly.instantiate = instantiate;
    return result;
  },
});

export function growMemory() {
  if (!memory) throw new Error("OpenTUI WASM has not instantiated");
  memory.grow(1);
}
