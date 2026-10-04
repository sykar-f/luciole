import React from "react";
import { serve, type ServerFunction } from "../packages/core/src/server";
// A Server built by hand whose answers take longer than Bun's default idle timeout (10 s):
// a page, a Server Function, and a stream that stays silent that long between values.
// Each sleep below is that slowness, simulated on purpose: none waits for an outcome.
const QUIET_MS = Number(process.env.SLOW_MS ?? 12_000);
const action = (fn: ServerFunction) => ({ fn, auth: "public" as const });
async function Slow() {
  await Bun.sleep(QUIET_MS);
  return React.createElement("text", null, "slow page");
}
serve({
  buildId: "build-1",
  manifest: {},
  routes: new Map([["/", { component: Slow, auth: "public" as const, url: "/", params: [] }]]),
  actions: new Map([
    [
      "a.ts#slow",
      action(async () => {
        await Bun.sleep(QUIET_MS);
        return "slow result";
      }),
    ],
    [
      "a.ts#quiet",
      action(async function* () {
        yield "first";
        await Bun.sleep(QUIET_MS);
        yield "second";
      }),
    ],
  ]),
});
