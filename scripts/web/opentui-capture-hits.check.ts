/** Explicit capture/release regression through xterm and OpenTUI. */
import { test } from "bun:test";
import { pixelJourney } from "./pixel-test-process";
const CLEANUP_MS = 5_000;
const TIMEOUT_MS = 180_000;
for (const dpr of [1, 2]) {
  for (const mode of ["pixels", "optOut"]) {
    test(
      `press after captured paint at DPR ${dpr}, ${mode}`,
      async () => {
        await pixelJourney(
          import.meta.dir + "/opentui-capture-hits.ts",
          [String(dpr), mode],
          TIMEOUT_MS,
          dpr,
        );
      },
      TIMEOUT_MS + CLEANUP_MS,
    );
  }
}
