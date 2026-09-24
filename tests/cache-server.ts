import React from "react";
import { cached } from "../src/cache/runtime";
import { cacheTag, invalidate, serve, type ServerFunction } from "../src/server";
// A Server built by hand, like tests/instrument-server.ts: a page reading a cached
// function, actions invalidating its tag, and every ServerEvent printed as a JSON line.
let runs = 0;
const count = cached(async () => {
  cacheTag("count");
  return ++runs;
}, "server/count.ts#count");
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
