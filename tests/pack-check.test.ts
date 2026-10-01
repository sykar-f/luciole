/**
 * scripts/pack-check.ts: a package that packs clean passes, and each way a tarball can be
 * unusable for a consumer (an unresolved `catalog:` spec, a missing export target, a test
 * shipped) fails it.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  checkPackage,
  importableSubpaths,
  manifestTargets,
  unresolvedSpecs,
} from "../scripts/pack-check";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A standalone package directory (outside any workspace) holding `files`. */
function fixture(manifest: Record<string, unknown>, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pack-fixture-"));
  temps.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.0.0", ...manifest }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

const good = {
  name: "fixture-good",
  type: "module",
  exports: { ".": "./dist/index.js" },
  files: ["dist"],
};

test("a package that packs clean installs and imports under node and bun", async () => {
  const dir = fixture(good, { "dist/index.js": "export const answer = 42;\n" });
  expect(await checkPackage(dir, () => {})).toEqual([]);
});

test("a catalog: dependency fails the check", async () => {
  const dir = fixture(
    { ...good, name: "fixture-catalog", dependencies: { marked: "catalog:" } },
    { "dist/index.js": "export {};\n" },
  );
  const problems = await checkPackage(dir, () => {});
  expect(problems.length).toBeGreaterThan(0);
});

test("an export target missing from the tarball fails the check", async () => {
  const dir = fixture({ ...good, name: "fixture-missing" }, { "src/index.js": "export {};\n" });
  const problems = await checkPackage(dir, () => {});
  expect(problems.join("\n")).toContain("./dist/index.js is not in the tarball");
});

test("a test shipped inside files fails the check", async () => {
  const dir = fixture(
    { ...good, name: "fixture-tests", files: ["dist", "src"] },
    { "dist/index.js": "export {};\n", "src/a.test.ts": "export {};\n" },
  );
  const problems = await checkPackage(dir, () => {});
  expect(problems.join("\n")).toContain("test in the tarball: src/a.test.ts");
});

test("the manifest readers", () => {
  expect(
    unresolvedSpecs({
      dependencies: { a: "workspace:*", b: "^1" },
      peerDependencies: { c: "catalog:" },
    }),
  ).toEqual(["dependencies.a: workspace:*", "peerDependencies.c: catalog:"]);
  expect(
    manifestTargets({
      exports: { ".": { bun: "./src/i.ts", default: "./dist/i.js" } },
      bin: { x: "./bin/x.js" },
      types: "./t.d.ts",
    }).sort(),
  ).toEqual(["./bin/x.js", "./dist/i.js", "./src/i.ts", "./t.d.ts"]);
  expect(
    importableSubpaths({
      exports: { ".": "./a.js", "./package.json": "./package.json", "./x/*": "./x/*.js" },
    }),
  ).toEqual(["."]);
});
