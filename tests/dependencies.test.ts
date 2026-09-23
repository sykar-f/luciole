import { test, expect } from "bun:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { dependencies } from "../package.json";

// Verify the renderer's real resolution: a stale nested reconciler can hide a failed upgrade.
test("OpenTUI uses the pinned reconciler and shares the application's React and Core", () => {
  const require = createRequire(import.meta.url);
  const rendererRequire = createRequire(require.resolve("@opentui/react"));
  const reconciler = z
    .object({ version: z.string() })
    .parse(
      JSON.parse(readFileSync(rendererRequire.resolve("react-reconciler/package.json"), "utf8")),
    );
  expect(reconciler.version).toBe(dependencies["react-reconciler"]);
  expect(rendererRequire("react")).toBe(require("react"));
  expect(rendererRequire.resolve("@opentui/core")).toBe(require.resolve("@opentui/core"));
});
