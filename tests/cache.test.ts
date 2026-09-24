import { expect, test } from "bun:test";

// The "use cache" runtime runs where the Server runs: under the `react-server` condition,
// which this `bun test` process does not use. tests/cache-runtime.check.ts holds the cases.
test("the use cache runtime (tests/cache-runtime.check.ts)", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=react-server",
      "--timeout",
      "20000",
      "./tests/cache-runtime.check.ts",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, output] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) console.error(output);
  expect(code).toBe(0);
});
