import React from "react";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { decodeReply, renderToReadableStream } from "./flight/server";
import { isAsyncIterable, messageOf } from "./guards";
import { appRoutes } from "./app-routes";
import { webAccess, type WebAccess } from "./web-routes";
import { INSTANCE_HEADER, InstanceKey, instanceManifests } from "./instance";
import { NotFoundError } from "./not-found";
import type { CacheHandler } from "./cache/handler";
import { renderPage } from "./cache/render";
import { Tag, configureCache, invalidateTags, type CacheEvent } from "./cache/runtime";
import { assertUncached } from "./cache/scope";
import { devtoolsInstrument } from "./devtools/server-agent";
import { configuredArgs } from "./args";
import { launchOf, type Launch } from "./launch";
export { memoryCache, type CacheEntry, type CacheHandler } from "./cache/handler";
export { sqliteCache } from "./cache/sqlite";
export { cacheLife, cacheTag, type CacheEvent, type CacheProfile } from "./cache/runtime";
export type Session = { userId: string; [key: string]: unknown };
export type RouteAuth = "public" | "required";
export type AuthConfig = {
  authenticate(request: Request): Session | null | Promise<Session | null>;
  unauthorizedPath?: string;
};
type Context = {
  session: Session | null;
  callId: string;
  /** Set during a Server Function call only: the paths it declared changed. */
  invalidations?: Set<string>;
  /** Likewise, the cache tags it invalidated, each with its purge, awaited before answering. */
  purges?: Map<string, Promise<void>>;
};
const context = new AsyncLocalStorage<Context>();
export function getSession() {
  assertUncached("getSession()");
  const c = context.getStore();
  if (!c) throw new Error("No request session");
  if (!c.session) throw new Error("Authentication required");
  return c.session;
}
export function getOptionalSession() {
  assertUncached("getOptionalSession()");
  const c = context.getStore();
  if (!c) throw new Error("No request session");
  return c.session;
}
/**
 * Ends a page render with the nearest `not-found.tsx`, inside the persistent layouts.
 * `what` names the missing resource for that screen; it is sent to the Client.
 */
export function notFound(what?: string): never {
  throw new NotFoundError(what);
}
const MAX_INVALIDATED_PATH = 1000;
/**
 * Declares, from a Server Function, that data shown under `path` changed. The Client
 * revalidates the matching routes and notifies `useInvalidation` subscribers after the
 * call answers; `"/"` (the default) covers every route.
 */
export function invalidate(path?: string): void;
/**
 * Drops the "use cache" results labelled `tag`; resolves once they are gone. Callable
 * anywhere on the Server. In a Server Function, the call also answers only after the
 * purge, and its Client revalidates the routes whose render read `tag`. Elsewhere (a
 * background job, a webhook, the DevTools agent) only the Server cache is purged: no
 * Client is told, each sees fresh data on its next render (see docs/CACHE.md).
 */
export function invalidate(target: { tag: string }): Promise<void>;
export function invalidate(target: string | { tag: string } = "/"): void | Promise<void> {
  const c = context.getStore();
  if (typeof target === "object" && target !== null) {
    const tag = Tag.parse(target.tag);
    const known = c?.purges?.get(tag);
    if (known) return known;
    const purge = invalidateTags([tag]);
    // A caller that never awaits (or an action that throws first) must not leave it unhandled.
    purge.catch(() => {});
    c?.purges?.set(tag, purge);
    return purge;
  }
  if (!c?.invalidations)
    throw new Error("invalidate(path) is only available in Server Functions: no Client to tell");
  if (typeof target !== "string" || !target.startsWith("/") || target.length > MAX_INVALIDATED_PATH)
    throw new Error("invalidate() takes an absolute path");
  c.invalidations.add(target);
}
/**
 * This Server's application arguments (`app/args.ts`), parsed at its start; `undefined`
 * when the application declares none. Typed through the definition instead:
 * `import cli from "../app/args"; cli.get()`.
 */
export function getArgs(): unknown {
  return configuredArgs()?.value;
}
/**
 * This Server's launch: its scope (`luciole.server` of the package.json), its id when each
 * launch has its own Server (`per-launch`), and the directory the command ran in.
 */
export function getLaunch(): Launch {
  return (launch ??= launchOf(process.env, process.cwd()));
}
let launch: Launch | undefined;
export function getCallId() {
  return context.getStore()?.callId;
}
/** Authoritative page registry, keyed by the build's routeId. */
export type ServerRoute = {
  component: React.ComponentType<{
    params: Record<string, string>;
    searchParams: Record<string, string>;
  }>;
  auth: RouteAuth;
  /** URL pattern with `$name` parameters, used only to validate `unauthorizedPath`. */
  url: string;
  params: readonly string[];
};
/**
 * A function exported by a "use server" module. Its arguments arrive decoded from the
 * request, unchecked: validating them is the function's own first step.
 */
export type ServerFunction = (...args: unknown[]) => unknown;
/**
 * What the Server observes of each `/render` and `/action`, for DevTools, logs or
 * tracing. `callId` is the Client's `x-luciole-call`, also in its `TransportEvent`s;
 * `target` is the routeId or Server Function id as requested (unchecked). `at` is epoch
 * milliseconds, `ms` counts from the request's arrival. `end` follows the body, a live
 * one included; `error` replaces `response` when a handler threw (the Client gets a
 * generic 500), and ends a body that failed while streaming. `failure` is not terminal:
 * one per error a page's render raised (not a not-found), anywhere between `request` and
 * the last event, `response` included; the stream goes on to the Client's error boundary.
 * `at` comes from the Server process's own clock; correlate with the Client's events
 * by `callId`, not by comparing `at` across processes.
 */
export type ServerEvent = {
  callId: string;
  at: number;
  kind: "render" | "action";
  target: string;
} & (
  | { type: "request" }
  | { type: "response"; status: number; ms: number }
  | { type: "end"; ms: number; bytes: number; cancelled: boolean }
  | { type: "error"; ms: number; message: string }
  | { type: "failure"; ms: number; message: string }
);
/**
 * Receives `ServerEvent`s, and each "use cache" operation (`CacheEvent`, src/cache/runtime.ts)
 * synchronously, on the request path: keep it cheap, never throw.
 */
export type ServerInstrument = { onEvent: (event: ServerEvent | CacheEvent) => void };
export type ServerConfig = {
  buildId: string;
  manifest: unknown;
  actions: Map<string, { fn: ServerFunction; auth: RouteAuth }>;
  routes: Map<string, ServerRoute>;
  auth?: AuthConfig;
  instrument?: ServerInstrument;
  /** Where "use cache" results live: `server/cache.ts`, in memory by default. */
  cache?: CacheHandler;
  /** The build's application bundle (`.luciole/app`), served to hosts when it exists. */
  appBundle?: string;
  /** The build's web runtime (`.luciole/web`, `luciole build --web`), for browsers. */
  web?: string;
};
/** JSON text from a request, parsed then checked by `schema`; `null` when either fails. */
function parseJson<T>(schema: z.ZodType<T>, raw: string) {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
// Never trust the Client's route guard: the route, its exact parameters and auth are
// validated here before any page code runs.
const paramsSchema = (route: ServerRoute) =>
  z.strictObject(Object.fromEntries(route.params.map((name) => [name, z.string().min(1)])));
const SEARCH_KEYS = 32,
  SEARCH_VALUE = 1000;
// Search comes from the URL and is untrusted: string values under bounded keys only.
const Search = z
  .record(z.string().regex(/^[\w.-]{1,64}$/), z.string().max(SEARCH_VALUE))
  .refine((search) => Object.keys(search).length <= SEARCH_KEYS);
// Decoded by Flight from the request body: one argument per parameter.
const Arguments = z.array(z.unknown());
// The Client's event clock (src/transport.ts): `at` compares across both processes.
const now = () => performance.timeOrigin + performance.now();
// What the Server's log says of an error: its name, never its message.
const nameOf = (error: unknown) => (error instanceof Error ? error.name : "Error");
const ROUTES = { "/render": "render", "/action": "action" } as const;
const kindOf = (req: Request, url: URL) =>
  url.pathname === "/render" && req.method === "GET"
    ? ROUTES["/render"]
    : url.pathname === "/action" && req.method === "POST"
      ? ROUTES["/action"]
      : undefined;
// Counts what the Client reads of a response, to its end, failure or cancellation.
function observeBody(
  body: ReadableStream<Uint8Array> | null,
  emit: (
    event: { type: "end"; bytes: number; cancelled: boolean } | { type: "error"; message: string },
  ) => void,
) {
  let bytes = 0;
  if (!body) {
    emit({ type: "end", bytes, cancelled: false });
    return null;
  }
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          emit({ type: "end", bytes, cancelled: false });
          controller.close();
          return;
        }
        bytes += value.byteLength;
        controller.enqueue(value);
      } catch (e) {
        emit({ type: "error", message: messageOf(e) });
        controller.error(e);
      }
    },
    cancel(reason) {
      emit({ type: "end", bytes, cancelled: true });
      return reader.cancel(reason);
    },
  });
}
const STATUS = {
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  conflict: 409,
  serverError: 500,
} as const;
/**
 * What the handler asks of where it runs. `serve()` answers for Bun; a host without a
 * listening server (a browser Worker, docs/WEB.md W2) leaves both out.
 */
export type HandlerOptions = {
  /** Who is signed in: `server/auth.ts`, or `serve()`'s bearer check. */
  auth: AuthConfig;
  /** Development only: the address of `luciole devtools`. */
  devtools?: string;
  /** Exposes `/test-metrics`. */
  testing?: boolean;
  /** What browsers may do; by default nothing (src/web-routes.ts). */
  web?: WebAccess;
  /** A live response is about to start: it must outlive any idle timeout. */
  keepAlive?: (req: Request) => void;
  /**
   * Test-only fault: called after a Server Function that returned `{ ok: true }` has
   * committed, before its response is written.
   */
  dropAfterCommit?: () => void;
};
/**
 * The Server as a function of a Request: pages, Server Functions, the application
 * bundle, instrumentation. Everything that listens, binds or exits stays in `serve()`.
 */
export function createHandler(config: ServerConfig, options: HandlerOptions) {
  const { auth, testing = false, web = webAccess(undefined, undefined) } = options;
  const paramSchemas = new Map(
    [...config.routes].map(([id, route]) => [id, paramsSchema(route)] as const),
  );
  if (auth.unauthorizedPath) {
    const login = [...config.routes.values()].find((r) => r.url === auth.unauthorizedPath);
    if (!login) throw new Error(`Authentication route not found: ${auth.unauthorizedPath}`);
    if (login.auth !== "public")
      throw new Error(`Authentication route must be public: ${auth.unauthorizedPath}`);
  }
  const instrument = devtoolsInstrument(config.instrument, options.devtools, {
    buildId: config.buildId,
    getCallId,
    invalidateTag: (tag) => invalidate({ tag }),
  });
  // The cache reports through the same instrument as requests: the DevTools see both.
  // One set of arguments per Server: a cache shared by processes (sqliteCache) keeps
  // their results apart.
  const fingerprint = configuredArgs()?.fingerprint;
  configureCache({
    buildId: fingerprint ? `${config.buildId}#${fingerprint}` : config.buildId,
    handler: config.cache,
    onEvent: instrument?.onEvent,
    callId: getCallId,
  });
  const metrics = { renders: 0, actions: 0 };
  const manifestFor = instanceManifests(config.manifest);
  const bundleRoutes = appRoutes(config.appBundle);
  // `failed` hears a handler's exception before it becomes the generic 500, `renderFailed`
  // each error a page's render raised, which streams on to the Client's error boundary.
  async function handle(
    req: Request,
    url: URL,
    callId: string,
    failed?: (error: unknown) => void,
    renderFailed?: (error: unknown) => void,
  ) {
    const arrived = performance.now();
    if (!web.admits(req))
      return new Response("Browser origins are unsupported", { status: STATUS.forbidden });
    const page = web.serve(req, url);
    if (page) return page;
    // Before the session and the build check: how a host learns the build (src/app-routes.ts).
    const bundled = bundleRoutes(req, url);
    if (bundled) return bundled;
    try {
      const session = await auth.authenticate(req);
      if (url.pathname === "/health") {
        if (!session) return new Response("Unauthorized", { status: STATUS.unauthorized });
        return Response.json({ buildId: config.buildId, pid: process.pid });
      }
      if (req.headers.get("x-luciole-build") !== config.buildId)
        return new Response("Incompatible build: install matching Client and Server", {
          status: STATUS.conflict,
        });
      // A pane of a multi-pane host: its Client References carry its key (docs/EMBEDDING.md).
      const instance = req.headers.get(INSTANCE_HEADER);
      const key = instance === null ? undefined : InstanceKey.safeParse(instance);
      if (key && !key.success)
        return new Response("Invalid instance key", { status: STATUS.badRequest });
      const manifest = manifestFor(key?.data);
      const unauthorized = () =>
        new Response("Authentication required", {
          status: STATUS.unauthorized,
          headers: auth.unauthorizedPath ? { "x-luciole-login": auth.unauthorizedPath } : undefined,
        });
      // Awaited: a rejection must reach the generic 500 below, never Bun's error page.
      return await context.run({ session, callId }, async () => {
        if (url.pathname === "/render" && req.method === "GET") {
          const routeId = url.searchParams.get("route") ?? "";
          const route = config.routes.get(routeId);
          const schema = paramSchemas.get(routeId);
          if (!route || !schema)
            return new Response("Route not found", { status: STATUS.notFound });
          const params = parseJson(schema, url.searchParams.get("params") ?? "{}");
          if (!params)
            return new Response("Invalid route parameters", { status: STATUS.badRequest });
          const search = url.searchParams.get("search");
          const searchParams = search === null ? {} : parseJson(Search, search);
          if (!searchParams)
            return new Response("Invalid search parameters", { status: STATUS.badRequest });
          if (route.auth === "required" && !session) return unauthorized();
          metrics.renders++;
          const tree = React.createElement(route.component, { params, searchParams });
          // `{ tree, tags }`: the cache tags the page read follow it (docs/CACHE.md).
          // Flight hands the Client a digest only: the Server keeps the trace, a name and
          // never a message, which may carry user data.
          const fail = (error: unknown) => {
            console.error("Render failed", callId, routeId, nameOf(error));
            renderFailed?.(error);
          };
          const body = renderPage(tree, (model) => renderToReadableStream(model, manifest, fail));
          return new Response(body, {
            headers: {
              "content-type": "text/x-component",
              "cache-control": "no-store",
            },
          });
        }
        if (url.pathname === "/action" && req.method === "POST") {
          const invalidations = new Set<string>(),
            purges = new Map<string, Promise<void>>();
          const store = context.getStore();
          if (!store) throw new Error("No request context");
          Object.assign(store, { invalidations, purges });
          const entry = config.actions.get(req.headers.get("x-luciole-action") ?? "");
          if (!entry) return new Response("Unknown action", { status: STATUS.notFound });
          if (entry.auth === "required" && !session) return unauthorized();
          metrics.actions++;
          const body = req.headers.get("content-type")?.startsWith("multipart/form-data")
            ? await req.formData()
            : await req.text();
          const args = Arguments.safeParse(await decodeReply(body, {}));
          if (!args.success)
            return new Response("Arguments must be an array", {
              status: STATUS.badRequest,
            });
          const value: unknown = await entry.fn(...args.data);
          // The Client refetches as soon as it reads the answer: purged entries first.
          await Promise.all(purges.values());
          // A live response may stay quiet longer than the idle timeout; it ends with
          // its generator or when the Client goes away.
          if (isAsyncIterable(value)) options.keepAlive?.(req);
          // Test-only fault injection occurs strictly after business commit; never enabled by a request.
          if (
            options.dropAfterCommit &&
            typeof value === "object" &&
            value !== null &&
            "ok" in value &&
            value.ok
          )
            options.dropAfterCommit();
          return new Response(
            renderToReadableStream(
              {
                kind: "result",
                value,
                callId,
                invalidate: [...invalidations],
                tags: [...purges.keys()],
              },
              manifest,
            ),
            {
              headers: {
                "content-type": "text/x-component",
                // The root value exists once the function returned: the Client's wait
                // for it, minus the network. A page renders inside its stream, after
                // the headers, so `/render` has no such figure.
                "server-timing": `total;dur=${(performance.now() - arrived).toFixed(1)}`,
              },
            },
          );
        }
        if (url.pathname === "/test-metrics" && testing)
          return session ? Response.json(metrics) : unauthorized();
        return new Response("Not found", { status: STATUS.notFound });
      });
    } catch (error) {
      failed?.(error);
      const callId = req.headers.get("x-luciole-call") ?? "request";
      console.error("Request failed", callId, nameOf(error));
      return new Response("Server request failed", { status: STATUS.serverError });
    }
  }
  // Emits `ServerEvent`s around `handle`, following the body to its end.
  async function observe(
    req: Request,
    url: URL,
    kind: ServerEvent["kind"],
    onEvent: ServerInstrument["onEvent"],
  ) {
    const start = performance.now();
    const ms = () => Math.round(performance.now() - start);
    const callId = req.headers.get("x-luciole-call") ?? crypto.randomUUID();
    const tag = {
      callId,
      kind,
      target:
        (kind === "render" ? url.searchParams.get("route") : req.headers.get("x-luciole-action")) ??
        "",
    };
    onEvent({ ...tag, at: now(), type: "request" });
    let threw = false;
    const response = await handle(
      req,
      url,
      callId,
      (error) => {
        threw = true;
        onEvent({ ...tag, at: now(), type: "error", ms: ms(), message: messageOf(error) });
      },
      (error) =>
        onEvent({ ...tag, at: now(), type: "failure", ms: ms(), message: messageOf(error) }),
    );
    if (threw) return response;
    onEvent({ ...tag, at: now(), type: "response", status: response.status, ms: ms() });
    const body = observeBody(response.body, (event) =>
      onEvent({ ...tag, at: now(), ms: ms(), ...event }),
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  return (req: Request, url = new URL(req.url)) => {
    // Where future middlewares go (a render cache, for instance): around `handle`,
    // keyed by `kind`, with the request's callId, before any page or action code runs
    // and with the Response it produced. Instrumentation is the first of them.
    const kind = instrument && kindOf(req, url);
    if (instrument && kind) return observe(req, url, kind, instrument.onEvent);
    return handle(req, url, req.headers.get("x-luciole-call") ?? crypto.randomUUID());
  };
}
// The process that listens (src/serve.ts): environment, Bun.serve, socket, lifetime, signals.
export { serve } from "./serve";
