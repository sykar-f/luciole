import { expect, test } from "bun:test";
import { AsyncLocalStorage, hooks } from "../packages/core/src/web/async-context/storage";
import { transformAsyncContext } from "../packages/core/src/web/async-context/transform";

test("every wait keeps the frame it was in: await, async yield, for await", () => {
  const out = transformAsyncContext(
    `async function f(x) { await x; for await (const y of z) g(y); }
     async function* h() { yield 1; }
     function* sync() { yield 2; }`,
    "module.ts",
  );
  expect(out).toContain("__ac.resume(__ac.save(), await x)");
  expect(out).toContain("__ac.resume(__ac.save(), (yield 1))");
  expect(out).toContain("yield 2;");
  expect(out).toMatch(/const __acFrame\w* = __ac\.save\(\);\s*for await/);
});

test("a module without waits is left as it is", () => {
  const source = "export const a = 1;\n";
  expect(transformAsyncContext(source, "a.ts")).toBe(source);
});

test("stores nest, exit and restore like Node's AsyncLocalStorage", () => {
  const request = new AsyncLocalStorage<number>();
  const other = new AsyncLocalStorage<string>();
  const seen: unknown[] = [];
  request.run(1, () => {
    other.run("a", () => {
      seen.push(request.getStore(), other.getStore());
      const frame = hooks.save();
      request.run(2, () => seen.push(request.getStore()));
      request.exit(() => seen.push(request.getStore()));
      hooks.resume(frame, undefined);
      seen.push(request.getStore());
    });
    seen.push(other.getStore());
  });
  seen.push(request.getStore());
  expect(seen).toEqual([1, "a", 2, undefined, 1, undefined, undefined]);
});
