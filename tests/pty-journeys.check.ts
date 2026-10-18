/**
 * Explicit affected PTY journeys, outside bun test discovery. Run with
 * `orch test run tests/pty-journeys.check.ts` to record their results.
 * Shared example builds require sequential execution; notes-frame builds Notes
 * before smoke uses it. published.ts is a helper exercised by generic/sandbox.
 */
import { expect, test } from "bun:test";
import { execute } from "./helpers";

const JOURNEY_MS = 240_000;
for (const script of [
  "notes-frame",
  "smoke",
  "chat",
  "coder",
  "devtools",
  "files",
  "flow",
  "forge",
  "mdreader",
  "mux",
  "restore",
  "generic",
  "sandbox",
]) {
  test(
    `PTY ${script}`,
    async () => {
      // Files expects built artifacts; unlike the other journeys, it does not build.
      if (script === "files") {
        const built = await execute([
          process.execPath,
          "packages/core/src/cli.ts",
          "build",
          "--app",
          "examples/files",
        ]);
        console.log(built.stdout.toString());
        console.error(built.stderr.toString());
        expect(built.exitCode, "Files prerequisite build").toBe(0);
      }
      const result = await execute([process.execPath, `scripts/pty/${script}.ts`]);
      console.log(result.stdout.toString());
      console.error(result.stderr.toString());
      expect(result.exitCode, script).toBe(0);
    },
    JOURNEY_MS,
  );
}
