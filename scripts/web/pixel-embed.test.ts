/** Record the existing rendering/wheel journey without changing its assertions. */
import { test } from "bun:test";
import { pixelJourney } from "./pixel-test-process";

const TIMEOUT_MS = 180_000;
const CLEANUP_MS = 5_000;
const browserTest = process.env.LUCIOLE_WEB_SMOKE === "1" ? test : test.skip;
browserTest(
  "the existing embed rendering and wheel journey",
  async () => {
    await pixelJourney(import.meta.dir + "/embed.ts", [], TIMEOUT_MS);
  },
  TIMEOUT_MS + CLEANUP_MS,
);
