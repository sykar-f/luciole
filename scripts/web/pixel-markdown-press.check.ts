/** Explicit Markdown editor browser proof. Never part of automatic test discovery. */
import { test } from "bun:test";
import { pixelJourney } from "./pixel-test-process";
const CLEANUP_MS = 5_000;
const TIMEOUT_MS = 180_000;
for (const dpr of [1, 2]) {
  test(
    `pixel editor copy then press ingress at DPR ${dpr}`,
    async () => {
      await pixelJourney(
        import.meta.dir + "/pixel-markdown-press.ts",
        [String(dpr)],
        TIMEOUT_MS,
        dpr,
      );
    },
    TIMEOUT_MS + CLEANUP_MS,
  );
}

for (const dpr of [1, 2]) {
  test(
    `pixel editor accepts the next press after a captured paint at DPR ${dpr}`,
    async () => {
      await pixelJourney(
        import.meta.dir + "/pixel-markdown-press.ts",
        [String(dpr), "capture"],
        TIMEOUT_MS,
        dpr,
      );
    },
    TIMEOUT_MS + CLEANUP_MS,
  );
}

for (const dpr of [1, 2]) {
  test(
    `pixel editor accepts a scrollbar press after a captured paint at DPR ${dpr}`,
    async () => {
      await pixelJourney(
        import.meta.dir + "/pixel-markdown-press.ts",
        [String(dpr), "capture-bar"],
        TIMEOUT_MS,
        dpr,
      );
    },
    TIMEOUT_MS + CLEANUP_MS,
  );
}

test(
  "pixel editor scrollbar press with pixel scroll off",
  async () => {
    await pixelJourney(
      import.meta.dir + "/pixel-markdown-press.ts",
      ["1", "capture-bar", "optOut"],
      TIMEOUT_MS,
      1,
    );
  },
  TIMEOUT_MS + CLEANUP_MS,
);
