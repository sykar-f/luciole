import React from "react";
import { serve, type ServerFunction } from "../packages/luciole/src/server";
// A Server built by hand, without `luciole build`, whose instrument prints each event as
// one JSON line after the ready line (tests/instrument.test.ts reads them).
const action = (fn: ServerFunction) => ({ fn, auth: "public" as const });
serve({
  buildId: "build-1",
  manifest: {},
  routes: new Map([
    [
      "/",
      {
        component: () => React.createElement("text", null, "home"),
        auth: "public" as const,
        url: "/",
        params: [],
      },
    ],
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
