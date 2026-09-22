import React from "react";
import { AsyncLocalStorage } from "node:async_hooks";
import { decodeReply, renderToReadableStream } from "./flight/server";
export type Session = { userId: string; [key: string]: unknown };
export type RouteAuth = "public" | "required";
export type AuthConfig = {
  authenticate(request: Request): Session | null | Promise<Session | null>;
  unauthorizedPath?: string;
};
type Context = { session: Session | null; callId: string };
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
export function getCallId() {
  return context.getStore()?.callId;
}
/** Authoritative page registry, keyed by the build's routeId. */
export type ServerRoute = {
  component: React.ComponentType<{ params: Record<string, string> }>;
  auth: RouteAuth;
  /** URL pattern with `$name` parameters, used only to validate `unauthorizedPath`. */
  url: string;
  params: readonly string[];
};
export type ServerConfig = {
  buildId: string;
  manifest: unknown;
  actions: Map<string, { fn: Function; auth: RouteAuth }>;
  routes: Map<string, ServerRoute>;
  auth?: AuthConfig;
};
// Never trust the Client's route guard: the route, its exact parameters and auth are
// validated here before any page code runs.
function parseParams(route: ServerRoute, raw: string | null) {
  let value: unknown;
  try {
    value = JSON.parse(raw ?? "{}");
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length !== route.params.length) return null;
  for (const [key, param] of entries)
    if (!route.params.includes(key) || typeof param !== "string" || !param) return null;
  return value as Record<string, string>;
}
export function serve(config: ServerConfig) {
  const hostname = process.env.TERMINAL_HOST ?? "127.0.0.1",
    token = process.env.TERMINAL_TOKEN;
  if (!["127.0.0.1", "localhost", "::1"].includes(hostname) && !token && !config.auth)
    throw new Error(
      "Remote binding requires TERMINAL_TOKEN or server/auth.ts and a TLS reverse proxy",
    );
  const auth: AuthConfig =
    config.auth ??
    ({
      authenticate(request) {
        if (token && request.headers.get("authorization") !== `Bearer ${token}`) return null;
        return { userId: process.env.TERMINAL_USER ?? "local" };
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
    port: Number(process.env.PORT ?? 3000),
    maxRequestBodySize: 1024 * 1024,
    idleTimeout: 30,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.headers.has("origin"))
        return new Response("Browser origins are unsupported", { status: 403 });
      try {
        const session = await auth.authenticate(req);
        if (url.pathname === "/health") {
          if (!session) return new Response("Unauthorized", { status: 401 });
          return Response.json({ buildId: config.buildId, pid: process.pid });
        }
        if (req.headers.get("x-terminal-build") !== config.buildId)
          return new Response("Incompatible build: install matching Client and Server", {
            status: 409,
          });
        const unauthorized = () =>
          new Response("Authentication required", {
            status: 401,
            headers: auth.unauthorizedPath
              ? { "x-terminal-login": auth.unauthorizedPath }
              : undefined,
          });
        const callId = req.headers.get("x-terminal-call") ?? crypto.randomUUID();
        // Awaited: a rejection must reach the generic 500 below, never Bun's error page.
        return await context.run({ session, callId }, async () => {
          if (url.pathname === "/render" && req.method === "GET") {
            const route = config.routes.get(url.searchParams.get("route") ?? "");
            if (!route) return new Response("Route not found", { status: 404 });
            const params = parseParams(route, url.searchParams.get("params"));
            if (!params) return new Response("Invalid route parameters", { status: 400 });
            if (route.auth === "required" && !session) return unauthorized();
            metrics.renders++;
            const tree = React.createElement(route.component, { params });
            return new Response(renderToReadableStream(tree, config.manifest), {
              headers: {
                "content-type": "text/x-component",
                "cache-control": "no-store",
              },
            });
          }
          if (url.pathname === "/action" && req.method === "POST") {
            const entry = config.actions.get(req.headers.get("x-terminal-action") ?? "");
            if (!entry) return new Response("Unknown action", { status: 404 });
            if (entry.auth === "required" && !session) return unauthorized();
            metrics.actions++;
            const body = req.headers.get("content-type")?.startsWith("multipart/form-data")
              ? await req.formData()
              : await req.text();
            const args = await decodeReply(body, {});
            if (!Array.isArray(args))
              return new Response("Arguments must be an array", {
                status: 400,
              });
            const value = await entry.fn(...args);
            // Test-only fault injection occurs strictly after business commit; never enabled by a request.
            if (
              process.env.TERMINAL_TEST === "1" &&
              process.env.TERMINAL_TEST_DROP_ONCE === "1" &&
              value?.ok
            ) {
              server.stop(true);
              process.exit(0);
            }
            return new Response(
              renderToReadableStream({ kind: "result", value, callId }, config.manifest),
              { headers: { "content-type": "text/x-component" } },
            );
          }
          if (url.pathname === "/test-metrics" && process.env.TERMINAL_TEST === "1")
            return session ? Response.json(metrics) : unauthorized();
          return new Response("Not found", { status: 404 });
        });
      } catch (error) {
        const callId = req.headers.get("x-terminal-call") ?? "request";
        console.error("Request failed", callId, error instanceof Error ? error.name : "Error");
        return new Response("Server request failed", { status: 500 });
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
    server.stop(true);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  return server;
}
