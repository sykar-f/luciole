/** A real Server process for the launch-environment relay test. */
import { serve } from "../packages/core/src/serve";
serve({
  buildId: "pixel-launch",
  manifest: {},
  actions: new Map(),
  routes: new Map(),
  web: process.env.PIXEL_WEB_DIRECTORY,
});
