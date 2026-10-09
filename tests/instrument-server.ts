import React from "react";
import { notFound, serve, type ServerFunction } from "../packages/core/src/server";
// A Server built by hand, without `luciole build`, whose instrument prints each event as
// one JSON line after the ready line (tests/instrument.test.ts reads them).
const action = (fn: ServerFunction) => ({ fn, auth: "public" as const });
const page = (url: string, component: () => React.ReactNode) => ({
  component,
  auth: "public" as const,
  url,
  params: [],
});
serve({
  buildId: "build-1",
  manifest: {},
  routes: new Map([
    ["/", page("/", () => React.createElement("text", null, "home"))],
    [
      "/broken",
      page("/broken", () => {
        throw new TypeError("boom");
      }),
    ],
    ["/missing", page("/missing", () => notFound("note"))],
    // Never resolves: the Client leaves before the page is done.
    ["/pending", page("/pending", () => React.use(new Promise<never>(() => {})))],
  ]),
  actions: new Map([
    ["a.ts#run", action(() => 42)],
    [
      "a.ts#boom",
      action(() => {
        throw new Error("boom");
      }),
    ],
  ]),
  instrument: { onEvent: (event) => console.log(JSON.stringify({ event })) },
});
