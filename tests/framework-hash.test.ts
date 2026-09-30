import { expect, test } from "bun:test";
import { frameworkFiles } from "../packages/luciole/src/framework-hash";

// A cached web runtime or git build is redone only if its sources change the hash.
test("the framework hash covers its sources, the web page and the OpenTUI patch", () => {
  const files = frameworkFiles();
  expect(files).toContain("src/framework-hash.ts");
  expect(files).toContain("src/web/platform/run.tsx");
  expect(files).toContain("src/web/index.html");
  expect(files.some((file) => /^web\/opentui-.*\.patch$/.test(file))).toBe(true);
});
