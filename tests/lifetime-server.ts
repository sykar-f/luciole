import React from "react";
import { serve } from "../packages/airtty/src/server";
// A Server built by hand whose build id a test chooses (TEST_BUILD_ID), to exercise the
// launcher's managed lifetime (src/launcher/lifetime.ts).
serve({
  buildId: process.env.TEST_BUILD_ID ?? "build-1",
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
  actions: new Map([["a.ts#run", { fn: () => 42, auth: "public" as const }]]),
});
