import React, { Suspense } from "react";
import { cached } from "../packages/core/src/cache/runtime";
import { cacheTag, invalidate, serve, type ServerFunction } from "../packages/core/src/server";
// A Server built by hand, like tests/instrument-server.ts: a page reading a cached
// function, actions invalidating its tag, and every ServerEvent printed as a JSON line.
let runs = 0;
const count = cached(async () => {
  cacheTag("count");
  return ++runs;
}, "server/count.ts#count");
// Read below Suspense, well after the shell: its tag still reaches the Client.
const late = cached(async () => {
  cacheTag("late");
  return "late data";
}, "server/late.ts#late");
// The /late page is held by two gates the test opens (through /open-page and /open-late), so
// what it proves is an order of events: no duration stands for "the page function is still
// running". Each test launches its own Server, so a gate left closed cannot reach another.
const pageGate = Promise.withResolvers<void>();
const lateGate = Promise.withResolvers<void>();
async function Late() {
  await lateGate.promise;
  return React.createElement("text", null, String(await late()));
}
const action = (fn: ServerFunction) => ({ fn, auth: "public" as const });
serve({
  buildId: "build-1",
  manifest: {},
  routes: new Map([
    [
      "/",
      {
        component: async () => React.createElement("text", null, `runs ${String(await count())}`),
        auth: "public" as const,
        url: "/",
        params: [],
      },
    ],
    [
      "/open-page",
      {
        component: () => {
          pageGate.resolve();
          return React.createElement("text", null, "open");
        },
        auth: "public" as const,
        url: "/open-page",
        params: [],
      },
    ],
    [
      "/open-late",
      {
        component: () => {
          lateGate.resolve();
          return React.createElement("text", null, "open");
        },
        auth: "public" as const,
        url: "/open-late",
        params: [],
      },
    ],
    [
      "/late",
      {
        // The page function is held until /open-page; its headers must not wait for it.
        component: async () => {
          await pageGate.promise;
          return React.createElement(
            "box",
            null,
            React.createElement("text", null, "shell"),
            React.createElement(Suspense, { fallback: "…" }, React.createElement(Late)),
          );
        },
        auth: "public" as const,
        url: "/late",
        params: [],
      },
    ],
  ]),
  actions: new Map([
    [
      "a.ts#bump",
      action(async () => {
        invalidate("/");
        await invalidate({ tag: "count" });
        return "bumped";
      }),
    ],
    ["a.ts#bad", action(() => invalidate({ tag: "a,b" }))],
  ]),
  instrument: { onEvent: (event) => console.log(JSON.stringify({ event })) },
});
