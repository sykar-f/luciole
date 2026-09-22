import React from "react";
import { AsyncLocalStorage } from "node:async_hooks";
import { decodeReply, renderToReadableStream } from "./flight/server";
type Context = { session: { userId: string }; callId: string };
const context = new AsyncLocalStorage<Context>();
export function getSession() {
  const c = context.getStore();
  if (!c) throw new Error("No request session");
  return c.session;
}
export function getCallId() {
  return context.getStore()?.callId;
}
export type ServerConfig = {
  buildId: string;
  manifest: unknown;
  actions: Map<string, Function>;
  layout: React.ComponentType<any>;
  routes: { path: string; component: React.ComponentType<any> }[];
};
export function serve(config: ServerConfig) {
  const hostname = process.env.TERMINAL_HOST ?? "127.0.0.1",
    token = process.env.TERMINAL_TOKEN;
  if (!["127.0.0.1", "localhost", "::1"].includes(hostname) && !token)
    throw new Error("Remote binding requires TERMINAL_TOKEN and a TLS reverse proxy");
  const metrics = { renders: 0, actions: 0 };
  const server = Bun.serve({
    hostname,
    port: Number(process.env.PORT ?? 3000),
    maxRequestBodySize: 1024 * 1024,
    idleTimeout: 30,
    async fetch(req) {
      const url = new URL(req.url);
      if (token && req.headers.get("authorization") !== `Bearer ${token}`)
        return new Response("Unauthorized", { status: 401 });
      if (req.headers.has("origin"))
        return new Response("Browser origins are unsupported", { status: 403 });
      if (url.pathname === "/health")
        return Response.json({ buildId: config.buildId, pid: process.pid });
      if (req.headers.get("x-terminal-build") !== config.buildId)
        return new Response("Incompatible build: install matching Client and Server", {
          status: 409,
        });
      const callId = req.headers.get("x-terminal-call") ?? crypto.randomUUID();
      return context.run(
        { session: { userId: process.env.TERMINAL_USER ?? "local" }, callId },
        async () => {
          try {
            if (url.pathname === "/render" && req.method === "GET") {
              metrics.renders++;
              const path = url.searchParams.get("path") ?? "/";
              let page: any,
                params: Record<string, string> = {};
              for (const route of [...config.routes].sort(
                (a, b) => Number(a.path.includes("[")) - Number(b.path.includes("[")),
              )) {
                const expected = route.path.split("/"),
                  actual = path.split("/");
                if (expected.length !== actual.length) continue;
                const values: Record<string, string> = {};
                if (
                  !expected.every((s, i) =>
                    s.startsWith("[")
                      ? ((values[s.slice(1, -1)] = decodeURIComponent(actual[i])), !!actual[i])
                      : s === actual[i],
                  )
                )
                  continue;
                page = route.component;
                params = values;
                break;
              }
              if (!page) return new Response("Route not found", { status: 404 });
              const tree = React.createElement(
                config.layout,
                null,
                React.createElement(page, { params }),
              );
              return new Response(renderToReadableStream(tree, config.manifest), {
                headers: {
                  "content-type": "text/x-component",
                  "cache-control": "no-store",
                },
              });
            }
            if (url.pathname === "/action" && req.method === "POST") {
              const action = config.actions.get(req.headers.get("x-terminal-action") ?? "");
              if (!action) return new Response("Unknown action", { status: 404 });
              metrics.actions++;
              const body = req.headers.get("content-type")?.startsWith("multipart/form-data")
                ? await req.formData()
                : await req.text();
              const args = await decodeReply(body, {});
              if (!Array.isArray(args))
                return new Response("Arguments must be an array", {
                  status: 400,
                });
              const value = await action(...args);
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
                renderToReadableStream(
                  { kind: "result", value, callId, refresh: true },
                  config.manifest,
                ),
                { headers: { "content-type": "text/x-component" } },
              );
            }
            if (url.pathname === "/test-metrics" && process.env.TERMINAL_TEST === "1")
              return Response.json(metrics);
            return new Response("Not found", { status: 404 });
          } catch (error) {
            console.error("Request failed", callId, error instanceof Error ? error.name : "Error");
            return new Response("Server request failed", { status: 500 });
          }
        },
      );
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
