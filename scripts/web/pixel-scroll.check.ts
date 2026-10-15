/** Explicit browser proof, outside automatic bun test discovery. */
import { test } from "bun:test";
import { pixelJourney } from "./pixel-test-process";

const TIMEOUT_MS = 20_000;
const CLEANUP_MS = 5_000;
for (const dpr of [1, 2]) {
  test(
    `pixel host presents atomic, clipped GPU frames at DPR ${dpr}`,
    async () => {
      await pixelJourney(import.meta.dir + "/pixel-scroll.ts", [String(dpr)], TIMEOUT_MS, dpr);
    },
    TIMEOUT_MS + CLEANUP_MS,
  );
}
