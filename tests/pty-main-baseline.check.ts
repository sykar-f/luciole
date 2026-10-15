/** Environment-only diagnostic: does not retry the recorded main journey failure. */
import { test } from "bun:test";

test("report the isolated PTY journey color environment once", () => {
  console.log(
    JSON.stringify({ COLORTERM: process.env.COLORTERM ?? null, TERM: process.env.TERM ?? null }),
  );
});
