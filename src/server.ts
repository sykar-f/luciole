import React from "react";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { decodeReply, renderToReadableStream } from "./flight/server";
import { isAsyncIterable } from "./guards";
import { NotFoundError } from "./not-found";
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
};
const context = new AsyncLocalStorage<Context>();
export function getSession() {
  const c = context.getStore();
  if (!c) throw new Error("No request session");
  if (!c.session) throw new Error("Authentication required");
  return c.session;
}
export function getOptionalSession() {
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
/**
 * Declares, from a Server Function, that data shown under `path` changed. The Client
 * revalidates the matching routes and notifies `useInvalidation` subscribers after the
 * call answers; `"/"` (the default) covers every route.
 */
const MAX_INVALIDATED_PATH = 1000;
export function invalidate(path = "/") {
  const c = context.getStore();
  if (!c?.invalidations) throw new Error("invalidate() is only available in Server Functions");
  if (typeof path !== "string" || !path.startsWith("/") || path.length > MAX_INVALIDATED_PATH)
    throw new Error("invalidate() takes an absolute path");
  c.invalidations.add(path);
}
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
export type ServerConfig = {
  buildId: string;
  manifest: unknown;
  actions: Map<string, { fn: ServerFunction; auth: RouteAuth }>;
  routes: Map<string, ServerRoute>;
  auth?: AuthConfig;
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
const DEFAULT_PORT = 3000,
  MAX_REQUEST_BYTES = 1_048_576, // 1 MiB
  IDLE_TIMEOUT_SECONDS = 30;
const ServerEnvironment = z.object({
  AIRTTY_HOST: z.string().default("127.0.0.1"),
  AIRTTY_TOKEN: z.string().optional(),
  AIRTTY_USER: z.string().default("local"),
  PORT: z.coerce.number().int().min(0).default(DEFAULT_PORT),
  // Test-only switches; never enabled by a request.
  AIRTTY_TEST: z.string().optional(),
  AIRTTY_TEST_DROP_ONCE: z.string().optional(),
});
const STATUS = {
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  conflict: 409,
  serverError: 500,
} as const;
export function serve(config: ServerConfig) {
  const env = ServerEnvironment.safeParse(process.env);
  if (!env.success) throw new Error(`Invalid Server environment: ${z.prettifyError(env.error)}`);
  const { AIRTTY_HOST: hostname, AIRTTY_TOKEN: token } = env.data;
  const testing = env.data.AIRTTY_TEST === "1";
  const paramSchemas = new Map(
    [...config.routes].map(([id, route]) => [id, paramsSchema(route)] as const),
  );
  if (!["127.0.0.1", "localhost", "::1"].includes(hostname) && !token && !config.auth)
    throw new Error(
      "Remote binding requires AIRTTY_TOKEN or server/auth.ts and a TLS reverse proxy",
    );
  const auth: AuthConfig =
    config.auth ??
    ({
      authenticate(request) {
        if (token && request.headers.get("authorization") !== `Bearer ${token}`) return null;
        return { userId: env.data.AIRTTY_USER };
      },
    } satisfies AuthConfig);
  if (auth.unauthorizedPath) {
    const login = [...config.routes.values()].find((r) => r.url === auth.unauthorizedPath);
    if (!login) throw new Error(`Authentication route not found: ${auth.unauthorizedPath}`);
    if (login.auth !== "public")
      throw new Error(`Authentication route must be public: ${auth.unauthorizedPath}`);
  }
  const metrics = { renders: 0, actions: 0 };
  const server = Bun.serve({
    hostname,
    port: env.data.PORT,
    maxRequestBodySize: MAX_REQUEST_BYTES,
    idleTimeout: IDLE_TIMEOUT_SECONDS,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.headers.has("origin"))
        return new Response("Browser origins are unsupported", { status: STATUS.forbidden });
      try {
        const session = await auth.authenticate(req);
        if (url.pathname === "/health") {
          if (!session) return new Response("Unauthorized", { status: STATUS.unauthorized });
          return Response.json({ buildId: config.buildId, pid: process.pid });
        }
        if (req.headers.get("x-airtty-build") !== config.buildId)
          return new Response("Incompatible build: install matching Client and Server", {
            status: STATUS.conflict,
          });
        const unauthorized = () =>
          new Response("Authentication required", {
            status: STATUS.unauthorized,
            headers: auth.unauthorizedPath
              ? { "x-airtty-login": auth.unauthorizedPath }
              : undefined,
          });
        const callId = req.headers.get("x-airtty-call") ?? crypto.randomUUID();
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
            return new Response(renderToReadableStream(tree, config.manifest), {
              headers: {
                "content-type": "text/x-component",
                "cache-control": "no-store",
              },
            });
          }
          if (url.pathname === "/action" && req.method === "POST") {
            const invalidations = new Set<string>();
            const store = context.getStore();
            if (!store) throw new Error("No request context");
            store.invalidations = invalidations;
            const entry = config.actions.get(req.headers.get("x-airtty-action") ?? "");
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
            // A live response may stay quiet longer than the idle timeout; it ends with
            // its generator or when the Client goes away.
            if (isAsyncIterable(value)) server.timeout(req, 0);
            // Test-only fault injection occurs strictly after business commit; never enabled by a request.
            if (
              testing &&
              env.data.AIRTTY_TEST_DROP_ONCE === "1" &&
              typeof value === "object" &&
              value !== null &&
              "ok" in value &&
              value.ok
            ) {
              void server.stop(true);
              process.exit(0);
            }
            return new Response(
              renderToReadableStream(
                { kind: "result", value, callId, invalidate: [...invalidations] },
                config.manifest,
              ),
              { headers: { "content-type": "text/x-component" } },
            );
          }
          if (url.pathname === "/test-metrics" && testing)
            return session ? Response.json(metrics) : unauthorized();
          return new Response("Not found", { status: STATUS.notFound });
        });
      } catch (error) {
        const callId = req.headers.get("x-airtty-call") ?? "request";
        console.error("Request failed", callId, error instanceof Error ? error.name : "Error");
        return new Response("Server request failed", { status: STATUS.serverError });
      }
    },
  });
  console.log(
    JSON.stringify({
      ready: true,
      port: server.port,
      pid: process.pid,
      buildId: config.buildId,
    }),
  );
  const shutdown = () => {
    void server.stop(true);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  return server;
}
