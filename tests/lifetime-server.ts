import React from "react";
import { z } from "zod";
import { serve } from "../packages/luciole/src/server";
import { configureArgs, defineArgs } from "../packages/luciole/src/args";
// A Server built by hand whose build id a test chooses (TEST_BUILD_ID), to exercise the
// launcher's managed lifetime (src/launcher/lifetime.ts); with TEST_ARGS, it declares
// application arguments (src/args.ts), as a generated Server entry does.
if (process.env.TEST_ARGS)
  await configureArgs(
    defineArgs({ options: z.object({ name: z.string().default("anyone") }).strict() }),
    process.env,
    process.cwd(),
  );
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
