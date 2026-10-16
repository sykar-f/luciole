/** Explicit Markdown editor browser proof. Never part of automatic test discovery. */
import { test } from "bun:test";
import { pixelJourney } from "./pixel-test-process";
const CLEANUP_MS = 5_000;
const TIMEOUT_MS = 180_000;
for (const dpr of [1, 2]) {
  test(
    `pixel markdown editor preserves visible content and selection at DPR ${dpr}`,
    async () => {
      await pixelJourney(
        import.meta.dir + "/pixel-markdown-editor.ts",
        [String(dpr)],
        TIMEOUT_MS,
        dpr,
      );
    },
    TIMEOUT_MS + CLEANUP_MS,
  );
}
