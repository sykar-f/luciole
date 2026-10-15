/** Explicit real-ScrollBox browser proof. Never part of automatic test discovery. */
import { test } from "bun:test";
import { pixelJourney } from "./pixel-test-process";
const CLEANUP_MS = 5_000;
const TIMEOUT_MS = 180_000;
for (const dpr of [1, 2]) {
  test(
    `pixel controller routes visible ScrollBox content at DPR ${dpr}`,
    async () => {
      await pixelJourney(import.meta.dir + "/pixel-controller.ts", [String(dpr)], TIMEOUT_MS, dpr);
    },
    TIMEOUT_MS + CLEANUP_MS,
  );
}
