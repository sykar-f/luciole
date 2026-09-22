// oxlint-disable-next-line typescript/triple-slash-reference -- Include ambient Flight module declarations when consumers import the framework.
/// <reference path="../../types.d.ts" />
// Versioned adapter: React Flight 19.3.0 browser codec, Bun 1.4.2.
// Bundled modules are synchronous and installed with the application; no code download.
export type ModuleResolver = (id: string) => Record<string, unknown>;
let resolve: ModuleResolver = (id) => {
  throw new Error(`Unknown Client module: ${id}`);
};
const loader = Object.assign((id: string) => resolve(id), {
  u: (id: string) => id,
});
(globalThis as any).__webpack_require__ = loader;
(globalThis as any).__webpack_chunk_load__ = () => {
  throw new Error("Dynamic Flight chunks are unsupported");
};
const codec = await import("react-server-dom-webpack/client.browser");
export function installResolver(next: ModuleResolver) {
  resolve = next;
  (globalThis as any).__webpack_require__ = loader;
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
