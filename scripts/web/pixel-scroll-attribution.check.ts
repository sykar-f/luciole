/** A delayed frame consumer must key scrollbar pixels by their presented frame. */
import { test } from "bun:test";
import { pixelJourney } from "./pixel-test-process";
const CLEANUP_MS = 5_000;
const TIMEOUT_MS = 180_000;
for (const dpr of [1, 2]) {
  test(
    `canonical scrollbar frames expose current-state misattribution at DPR ${dpr}`,
    async () => {
      await pixelJourney(
        import.meta.dir + "/pixel-markdown-press.ts",
        [String(dpr), "attribution"],
        TIMEOUT_MS,
        dpr,
      );
    },
    TIMEOUT_MS + CLEANUP_MS,
  );
}
