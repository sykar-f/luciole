/**
 * Explicit browser checks, outside bun test's automatic discovery. Run with
 * `orch test run tests/web-journeys.check.ts` to record the scripts' results.
 * These journeys build shared example outputs, so keep them sequential.
 */
import { expect, test } from "bun:test";
import { execute } from "./helpers";

const JOURNEY_MS = 240_000;
for (const command of [
  "test:web",
  "test:web:local",
  "test:web:forge",
  "test:web:coder",
  "test:web:embed",
  "test:web:landing",
]) {
  test(
    command,
    async () => {
      const result = await execute([process.execPath, "run", command]);
      console.log(result.stdout.toString());
      console.error(result.stderr.toString());
      expect(result.exitCode, command).toBe(0);
    },
    JOURNEY_MS,
  );
}
