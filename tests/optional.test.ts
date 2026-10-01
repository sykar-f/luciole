import { describe, expect, test } from "bun:test";
import { assertInstalled, loadOptional } from "../packages/luciole/src/optional";

describe("optional dependencies", () => {
  test("a missing package is reported with the command that installs it", async () => {
    const missing = "luciole-test-not-installed";
    const error = await loadOptional("luciole/math", missing, () =>
      import(missing).then((module: unknown) => module),
    ).catch((thrown: unknown) => thrown);
    if (!(error instanceof Error)) throw new Error("loadOptional did not throw");
    expect(error.message).toContain(`luciole/math needs the optional package ${missing}`);
    expect(error.message).toContain(`bun add ${missing}`);
  });

  test("an installed package loads", async () => {
    const zod = await loadOptional("luciole/math", "zod", () => import("zod"));
    expect(typeof zod.z.string).toBe("function");
  });

  test("another failure is not taken for a missing package", async () => {
    const failure = new Error("boom");
    const error = await loadOptional("luciole/math", "zod", () => Promise.reject(failure)).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBe(failure);
  });

  test("a build-time check names the package that is missing", () => {
    expect(() => assertInstalled("the web target", ["zod"])).not.toThrow();
    expect(() => assertInstalled("the web target", ["zod", "luciole-test-not-installed"])).toThrow(
      /the web target needs the optional package luciole-test-not-installed.*bun add luciole-test-not-installed/,
    );
  });
});
