import { expect, test } from "bun:test";
import { execute } from "./helpers";

for (const entry of ["node", "web"]) {
  test(`${entry} live cancellation and request signal`, async () => {
    const result = await execute(
      [process.execPath, "test", "--conditions=react-server", "./tests/live-cancel.check.ts"],
      { env: { ...process.env, FLIGHT_ENTRY: entry } },
    );
    console.log(result.stdout.toString());
    if (result.exitCode !== 0) console.error(result.stderr.toString());
    expect(result.exitCode).toBe(0);
  });
}
