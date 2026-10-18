import { expect, test } from "bun:test";
import { join } from "node:path";

const shim = join(import.meta.dir, "../packages/core/src/web/node/immediate.ts");

test("page immediates run in order with arguments, cancellation and unique handles", async () => {
  // Isolate Node globals: Bun provides the native implementation in the test runner.
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
    globalThis.setImmediate = undefined;
    globalThis.clearImmediate = undefined;
    await import(${JSON.stringify(shim)});
    const seen = [];
    const first = setImmediate((a, b) => {
      seen.push(a + b);
      setImmediate(() => seen.push("nested"));
    }, "a", "b");
    const cancelled = setImmediate(() => seen.push("cancelled"));
    const third = setImmediate(() => seen.push("third"));
    clearImmediate(cancelled);
    if (new Set([first, cancelled, third]).size !== 3) throw new Error("reused handle");
    seen.push("sync");
    queueMicrotask(() => seen.push("microtask"));
    await new Promise((resolve) => {
      const done = () => seen.includes("nested") ? resolve() : setImmediate(done);
      setImmediate(done);
    });
    console.log(JSON.stringify(seen));
    process.exit(0);
  `,
    ],
    { stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(5_000) },
  );
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, err }).toEqual({ code: 0, err: "" });
  expect(JSON.parse(out)).toEqual(["sync", "microtask", "ab", "third", "nested"]);
});

test("the page shim preserves an existing immediate implementation", async () => {
  const before = globalThis.setImmediate;
  const cancel = globalThis.clearImmediate;
  await import(shim);
  expect(globalThis.setImmediate).toBe(before);
  expect(globalThis.clearImmediate).toBe(cancel);
});
