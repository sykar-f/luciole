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
/**
 * Who resolves a Client Reference id, process-wide. A pane of the Client that has an
 * instance key (`ApplicationOptions.instance`) receives ids written `<key>@<buildId>/<path>`
 * by the Server and resolves them with its own modules; an id without a key goes to the
 * last resolver registered without one, the single Application of a Client today.
 *
 * React Flight's browser codec reads the single global `__webpack_require__`, lazily,
 * while React renders (`React.lazy`), long after the payload was decoded: no "resolver of
 * the current response" exists, only the id can name its pane (docs/EMBEDDING.md, O1).
 * The registry lives on globalThis so that every copy of the runtime (a Client bundle
 * imported twice, the generic Client's runtime) shares it.
 */
const REGISTRY = Symbol.for("luciole.modules");
type Registry = Map<string, ModuleResolver>;
const isRegistry = (value: unknown): value is Registry => value instanceof Map;
function registry(): Registry {
  const existing: unknown = Reflect.get(globalThis, REGISTRY);
  if (isRegistry(existing)) return existing;
  const created: Registry = new Map();
  Reflect.set(globalThis, REGISTRY, created);
  return created;
}
/** `p1@abc/app/x.tsx` → `["p1", "abc/app/x.tsx"]`; an id without a key → `["", id]`. */
export function splitInstance(id: string): [string, string] {
  const at = id.indexOf("@");
  // A key comes before the build ID's slash; a path may hold "@" (`node_modules/@scope`).
  return at > 0 && at < id.indexOf("/") ? [id.slice(0, at), id.slice(at + 1)] : ["", id];
}
const loader = Object.assign(
  (id: string) => {
    const [key, local] = splitInstance(id);
    const resolve = registry().get(key);
    if (!resolve) throw new Error(`Unknown Client module: ${id}`);
    return resolve(local);
  },
  { u: (id: string) => id },
);
globalThis.__webpack_require__ = loader;
globalThis.__webpack_chunk_load__ = () => {
  throw new Error("Dynamic Flight chunks are unsupported");
};
const codec = await import("react-server-dom-webpack/client.browser");
/**
 * Resolves the ids of instance `key` (`""`: ids without a key) with `resolver`, until the
 * returned function unregisters it. Registering a key again replaces its resolver.
 */
export function registerModules(key: string, resolver: ModuleResolver) {
  const modules = registry();
  modules.set(key, resolver);
  globalThis.__webpack_require__ = loader;
  return () => {
    if (modules.get(key) === resolver) modules.delete(key);
  };
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
