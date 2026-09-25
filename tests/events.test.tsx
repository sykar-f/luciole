/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { createRoute } from "@tanstack/react-router";
import { createApplication, type ApplicationEvent } from "../packages/airtty/src/client";
import { loadPage, pageRoute, rootRoute } from "../packages/airtty/src/route-tree";
import {
  createHttpTransport,
  now,
  type Fetch,
  type TransportEvent,
} from "../packages/airtty/src/transport";
import { renderBody, until } from "./helpers";

// One Flight model row: the root value, as JSON (see tests/http-transport.test.ts).
const row = (value: unknown) => new Response(`0:${JSON.stringify(value)}\n`);
// A `/render` answer: that row as the page stream of `{ tree, tags }`.
const page = (value: unknown) => new Response(renderBody(`0:${JSON.stringify(value)}\n`));
const callIdOf = (init: RequestInit) => new Headers(init.headers).get("x-airtty-call") ?? "";
// Answers every render with a string, and every call with 42; `#run` invalidates "/".
const server: (sent: string[]) => Fetch = (sent) => (url, init) => {
  sent.push(callIdOf(init));
  return Promise.resolve(
    url.pathname === "/render"
      ? page(`page ${url.searchParams.get("route")}`)
      : row({
          kind: "result",
          callId: callIdOf(init),
          value: 42,
          invalidate: new Headers(init.headers).get("x-airtty-action")?.endsWith("#run")
            ? ["/"]
            : [],
        }),
  );
};

test("every request sends its callId, and its events carry it with a timestamp", async () => {
  const sent: string[] = [];
  const events: TransportEvent[] = [];
  const transport = createHttpTransport({
    url: "http://terminal.invalid",
    buildId: "build-1",
    callServer: () => Promise.reject(new Error("unused")),
    fetch: server(sent),
    onEvent: (event) => events.push(event),
  });
  // Bracketed with the clock `at` comes from: the window is exact, whatever the load.
  const before = now();
  await transport.render("/", {}, new AbortController().signal, {}, { cause: "navigation" });
  expect(await transport.call("a.ts#run", [])).toBe(42);
  const after = now();
  expect(sent).toHaveLength(2);
  expect(new Set(sent).size).toBe(2);
  expect(events.map((e) => [e.type, e.kind, e.callId])).toEqual([
    ["request", "render", sent[0]],
    ["response", "render", sent[0]],
    ["chunk", "render", sent[0]],
    ["end", "render", sent[0]],
    ["request", "action", sent[1]],
    ["response", "action", sent[1]],
    ["chunk", "action", sent[1]],
    ["end", "action", sent[1]],
  ]);
  const ats = events.map((e) => e.at);
  expect(ats).toEqual([...ats].sort((a, b) => a - b));
  for (const at of ats) {
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
    // Epoch milliseconds, not the process-relative performance.now(): within a minute of
    // the wall clock (the monotonic clock drifts from it by milliseconds, never minutes).
    expect(Math.abs(at - Date.now())).toBeLessThan(60_000);
  }
  expect(events.flatMap((e) => (e.type === "request" ? [e.cause] : []))).toEqual([
    "navigation",
    "unknown",
  ]);
});

test("the Client labels each request with its cause and reports loaders and invalidations", async () => {
  const root = rootRoute(({ children }) => children);
  const page = (path: string) =>
    createRoute({
      getParentRoute: () => root,
      path,
      loader: (ctx) => loadPage(ctx, path, []),
      ...pageRoute([]),
    });
  const app = createApplication({
    url: "http://terminal.invalid",
    buildId: "build-1",
    resolveModule: (id) => {
      throw new Error(`Unknown Client module: ${id}`);
    },
    routeTree: root.addChildren([page("/"), page("/b")]),
    fetch: server([]),
  });
  const events: ApplicationEvent[] = [];
  const stop = app.onEvent((event) => events.push(event));
  const requests = () =>
    events.flatMap((e) => (e.type === "request" ? [`${e.kind} ${e.target} ${e.cause}`] : []));
  try {
    await app.router.load();
    await app.refresh();
    expect(await app.callServer("a.ts#run", [])).toBe(42);
    // The Server's invalidation is not awaited by the call: wait for its render.
    await until(() => requests().length === 4);
    await until(() => app.router.state.status === "idle");
    await app.router.preloadRoute({ to: "/b" });
    await app.withSignal(
      new AbortController().signal,
      () => app.callServer("a.ts#watch", []),
      "live",
    );
    expect(requests()).toEqual([
      "render / navigation",
      "render / refresh",
      "action a.ts#run action",
      "render / invalidation",
      "render /b preload",
      "action a.ts#watch live",
    ]);
    expect(
      events.flatMap((e) => (e.type === "invalidate" ? [`${e.origin} ${e.paths.join()}`] : [])),
    ).toEqual(["client /", "server /"]);
    expect(
      events.flatMap((e) =>
        e.type === "loader"
          ? [`${e.phase} ${e.routeId} ${e.cause}${e.phase === "end" ? ` ${e.result}` : ""}`]
          : [],
      ),
    ).toEqual([
      "start / navigation",
      "end / navigation ok",
      "start / refresh",
      "end / refresh ok",
      "start / invalidation",
      "end / invalidation ok",
      "start /b preload",
      "end /b preload ok",
    ]);
    expect(events.every((e) => typeof e.at === "number")).toBe(true);
  } finally {
    stop();
  }
});
