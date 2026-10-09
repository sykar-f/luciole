import React from "react";
import type { ServerFunction } from "../packages/core/src/server";
if (process.env.FLIGHT_ENTRY === "web") {
  Bun.plugin({
    name: "web-flight",
    setup(build) {
      build.onResolve({ filter: /^\.\/flight\/server$/ }, () => ({
        path: import.meta.resolve("../packages/core/src/web/platform/flight/server.ts"),
      }));
    },
  });
}
const { notFound, serve } = await import("../packages/core/src/server");
const signals = new Set<AbortSignal>();
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
    [
      "/pending",
      page("/pending", () => {
        const signal = React.cacheSignal();
        if (!(signal instanceof AbortSignal))
          throw new Error("Flight did not provide its cache signal");
        signals.add(signal);
        return React.use(new Promise<never>(() => {}));
      }),
    ],
  ]),
  actions: new Map([
    ["a.ts#run", action(() => 42)],
    ["a.ts#pending-state", action(() => [...signals].map((signal) => signal.aborted))],
    [
      "a.ts#boom",
      action(() => {
        throw new Error("boom");
      }),
    ],
  ]),
  instrument: { onEvent: (event) => console.log(JSON.stringify({ event })) },
});
