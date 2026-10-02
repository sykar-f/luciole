import React from "react";
import { serve } from "../packages/core/src/server";
// A Server built by hand for tests/devtools-server.test.ts: LUCIOLE_DEVTOOLS is its only
// instrumentation. The page and the action log, to check logs carry their callId.
serve({
  buildId: "build-1",
  manifest: {},
  routes: new Map([
    [
      "/",
      {
        component: () => {
          console.log("rendering home");
          return React.createElement("text", null, "home");
        },
        auth: "public" as const,
        url: "/",
        params: [],
      },
    ],
  ]),
  actions: new Map([
    [
      "a.ts#run",
      {
        fn: () => {
          console.warn("running", { n: 1 });
          return 42;
        },
        auth: "public" as const,
      },
    ],
  ]),
});
