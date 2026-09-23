// React Flight ships no declarations for these entries: types.d.ts declares them. An import
// cannot carry ambient module declarations, so a reference brings them to consumers too.
// oxlint-disable-next-line typescript/triple-slash-reference -- the ambient Flight declarations above.
/// <reference path="../../types.d.ts" />
// Versioned adapter: React Flight 19.3.0 browser codec, Bun 1.4.2.
// Bundled modules are synchronous and installed with the application; no code download.
export type ModuleResolver = (id: string) => Record<string, unknown>;
declare global {
  // The webpack runtime hooks React Flight's browser build calls to load Client modules.
  var __webpack_require__: ModuleResolver & { u: (id: string) => string };
  var __webpack_chunk_load__: () => never;
}
let resolve: ModuleResolver = (id) => {
  throw new Error(`Unknown Client module: ${id}`);
};
const loader = Object.assign((id: string) => resolve(id), {
  u: (id: string) => id,
});
globalThis.__webpack_require__ = loader;
globalThis.__webpack_chunk_load__ = () => {
  throw new Error("Dynamic Flight chunks are unsupported");
};
const codec = await import("react-server-dom-webpack/client.browser");
export function installResolver(next: ModuleResolver) {
  resolve = next;
  globalThis.__webpack_require__ = loader;
}
export const encodeReply = codec.encodeReply;
export const createServerReference = codec.createServerReference;
export function decode(
  stream: ReadableStream,
  callServer: (id: string, args: unknown[]) => Promise<unknown>,
) {
  return codec.createFromReadableStream(stream, {
    callServer,
    replayConsoleLogs: false,
  });
}
