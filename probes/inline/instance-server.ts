// Starts a built luciole Server ($SERVER_ENTRY) as if src/server.ts had the proposed instance
// prefix (docs/EMBEDDING.md, O1): a Client pane sends `x-luciole-instance: <key>`, and the
// Client References of every Flight payload answered to it are written as
// `<key>@<buildId>/<path>`, so the pane's module router finds that pane's modules.
//
// In src/ this is a few lines around `renderToReadableStream(tree, config.manifest)`.
// From outside, two process-wide patches applied before the Server loads: Bun.serve runs
// each request in a context carrying the header, and Flight's renderToPipeableStream
// receives a prefixed copy of the manifest. Server References (actions) keep their ids.
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";

const Instance = z.string().regex(/^[a-z0-9-]{1,32}$/);
const HEADER = "x-luciole-instance";
const current = new AsyncLocalStorage<string | undefined>();
const ClientReference = z.object({ id: z.string() }).loose();
const Manifest = z.record(z.string(), ClientReference);

// One prefixed copy per instance and manifest: built once, read on every reference.
const prefixed = new Map<string, Record<string, unknown>>();
function manifestFor(manifest: unknown, instance: string | undefined): unknown {
  if (instance === undefined) return manifest;
  const cached = prefixed.get(instance);
  if (cached) return cached;
  const copy = Object.fromEntries(
    Object.entries(Manifest.parse(manifest)).map(([key, entry]) => [
      key,
      { ...entry, id: `${instance}@${entry.id}` },
    ]),
  );
  prefixed.set(instance, copy);
  return copy;
}

// Reflect.apply is typed `any`: its results are only ever passed on, as unknown.
function invoke(f: Parameters<typeof Reflect.apply>[0], self: unknown, args: unknown[]): unknown {
  const result: unknown = Reflect.apply(f, self, args);
  return result;
}

const flight: unknown = require("react-server-dom-webpack/server.node");
if (typeof flight !== "object" || flight === null || !("renderToPipeableStream" in flight))
  throw new Error("react-server-dom-webpack/server.node has no renderToPipeableStream");
const render = flight.renderToPipeableStream;
if (typeof render !== "function") throw new Error("renderToPipeableStream is not a function");
// The Server bundle imports this CommonJS module after the patch: its namespace is built
// from these exports.
Reflect.set(
  flight,
  "renderToPipeableStream",
  (model: unknown, manifest: unknown, options: unknown) =>
    invoke(render, flight, [model, manifestFor(manifest, current.getStore()), options]),
);

const serve = Bun.serve.bind(Bun);
Reflect.set(Bun, "serve", (options: unknown): unknown => {
  if (typeof options !== "object" || options === null || !("fetch" in options))
    return invoke(serve, undefined, [options]);
  const fetch = options.fetch;
  if (typeof fetch !== "function") return invoke(serve, undefined, [options]);
  return invoke(serve, undefined, [
    {
      ...options,
      fetch(this: unknown, req: Request, server: unknown): unknown {
        const header = req.headers.get(HEADER);
        const instance = header === null ? undefined : Instance.parse(header);
        return current.run(instance, (): unknown => invoke(fetch, this, [req, server]));
      },
    },
  ]);
});

const entry = process.env.SERVER_ENTRY;
if (!entry) throw new Error("SERVER_ENTRY names the built Server to start");
await import(entry);
