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
  fieldTargets,
  inFiles,
  resolveExports,
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
  expect(problems.join("\n")).toContain("target ./dist/index.js (.) is not in the tarball");
});

test("a test shipped inside files fails the check", async () => {
  const dir = fixture(
    { ...good, name: "fixture-tests", files: ["dist", "src"] },
    { "dist/index.js": "export {};\n", "src/a.test.ts": "export {};\n" },
  );
  const problems = await checkPackage(dir, () => {});
  expect(problems.join("\n")).toContain("test in the tarball: src/a.test.ts");
});

test("wildcard exports are expanded: each match imports, a pattern matching nothing fails", async () => {
  const ok = fixture(
    { ...good, name: "fixture-wild", exports: { "./x/*": "./dist/x/*.js" } },
    { "dist/x/a.js": "export const a = 1;\n", "dist/x/b.js": "export const b = 2;\n" },
  );
  const logs: string[] = [];
  expect(await checkPackage(ok, (line) => logs.push(line))).toEqual([]);
  expect(logs.filter((line) => line.includes("under node")).length).toBe(2);
  const empty = fixture(
    { ...good, name: "fixture-wild-empty", exports: { "./x/*": "./dist/x/*.js" } },
    { "dist/other.js": "export {};\n" },
  );
  expect((await checkPackage(empty, () => {})).join("\n")).toContain("matches nothing");
});

test("a JSON export is imported with its attribute; an export that cannot be loaded fails", async () => {
  const dir = fixture(
    {
      ...good,
      name: "fixture-json",
      exports: {
        ".": "./dist/index.js",
        "./data": "./dist/data.json",
        "./package.json": "./package.json",
      },
    },
    { "dist/index.js": "export {};\n", "dist/data.json": '{"a":1}' },
  );
  const logs: string[] = [];
  expect(await checkPackage(dir, (line) => logs.push(line))).toEqual([]);
  expect(logs).toContain("fixture-json: import fixture-json/data under node ok");
  expect(logs).toContain("fixture-json: import fixture-json/package.json under bun ok");
  const css = fixture(
    {
      ...good,
      name: "fixture-css",
      exports: { ".": "./dist/index.js", "./style": "./dist/a.css" },
    },
    { "dist/index.js": "export {};\n", "dist/a.css": "a{}\n" },
  );
  expect((await checkPackage(css, () => {})).join("\n")).toContain("export ./style");
});

test("an import that fails under one runtime only is reported with that runtime", async () => {
  const dir = fixture(
    {
      ...good,
      name: "fixture-node-only",
      exports: { ".": { bun: "./dist/ok.js", default: "./dist/bad.js" } },
    },
    { "dist/ok.js": "export {};\n", "dist/bad.js": 'throw new Error("no node");\n' },
  );
  const problems = await checkPackage(dir, () => {});
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain("under node");
});

test("a null export exclusion is applied before wildcard imports are scheduled", async () => {
  const dir = fixture(
    {
      ...good,
      name: "fixture-null",
      exports: { "./x/*": "./dist/x/*.js", "./x/internal/*": null },
      files: ["dist"],
    },
    { "dist/x/a.js": "export const a = 1;\n", "dist/x/internal/secret.js": "export {};\n" },
  );
  const logs: string[] = [];
  expect(await checkPackage(dir, (line) => logs.push(line))).toEqual([]);
  expect(logs).toContain("fixture-null: import fixture-null/x/a under node ok");
  expect(logs.filter((line) => line.includes("internal"))).toEqual([]);
  const entries = ["dist/x/a.js", "dist/x/internal/secret.js"];
  const exports = { "./x/*": "./dist/x/*.js", "./x/internal/*": null, "./x/b": null };
  expect([...resolveExports({ exports }, entries).subpaths.keys()]).toEqual(["./x/a"]);
});

test("a more specific mapping wins over a wildcard that also matches", () => {
  const entries = ["dist/x/a.js", "dist/x/b.js", "dist/special.js"];
  const { subpaths } = resolveExports(
    { exports: { "./x/*": "./dist/x/*.js", "./x/b": "./dist/special.js" } },
    entries,
  );
  expect(subpaths.get("./x/a")).toEqual(["dist/x/a.js"]);
  expect(subpaths.get("./x/b")).toEqual(["dist/special.js"]);
});

test("a file packed outside files (a bin target) fails with outside files:", async () => {
  const dir = fixture(
    { ...good, name: "fixture-outside", bin: { outside: "./lib/cli.js" } },
    { "dist/index.js": "export {};\n", "lib/cli.js": "#!/usr/bin/env node\n" },
  );
  const problems = await checkPackage(dir, () => {});
  expect(problems).toEqual(["outside files: lib/cli.js"]);
});

test("a package whose engines name bun and not node is imported under bun only", async () => {
  const sources = { "dist/index.ts": "export const answer: number = 42;\n" };
  const dir = fixture(
    {
      ...good,
      name: "fixture-bun-only",
      exports: { ".": "./dist/index.ts" },
      engines: { bun: ">=1" },
    },
    sources,
  );
  const logs: string[] = [];
  expect(await checkPackage(dir, (line) => logs.push(line))).toEqual([]);
  expect(logs).toContain("fixture-bun-only: import fixture-bun-only under bun ok");
  expect(logs.filter((line) => line.includes("under node"))).toEqual([]);
  const open = fixture(
    { ...good, name: "fixture-ts-node", exports: { ".": "./dist/index.ts" } },
    sources,
  );
  expect((await checkPackage(open, () => {})).join("\n")).toContain("under node");
});

test("an export that needs the react-server condition is imported with it", async () => {
  const dir = fixture(
    {
      ...good,
      name: "fixture-rsc",
      exports: { ".": { "react-server": "./dist/rs.js", default: "./dist/plain.js" } },
      engines: { bun: ">=1" },
    },
    {
      "dist/rs.js": "export {};\n",
      "dist/plain.js":
        'throw new Error(\'The "react" package is not configured correctly. The "react-server" condition must be enabled\');\n',
    },
  );
  expect(await checkPackage(dir, () => {})).toEqual([]);
});

test("a workspace dependency installs from its own tarball, not from the registry", async () => {
  const root = mkdtempSync(join(tmpdir(), "pack-workspace-"));
  temps.push(root);
  const write = (path: string, content: unknown) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), JSON.stringify(content));
  };
  write("package.json", { name: "ws-root", private: true, workspaces: ["packages/*"] });
  write("packages/dep/package.json", {
    name: "pack-check-fixture-dep-zz9",
    version: "1.0.0",
    type: "module",
    exports: { ".": "./index.js" },
    files: ["index.js"],
  });
  writeFileSync(join(root, "packages/dep/index.js"), "export const dep = 1;\n");
  write("packages/app/package.json", {
    name: "pack-check-fixture-app-zz9",
    version: "1.0.0",
    type: "module",
    exports: { ".": "./index.js" },
    files: ["index.js"],
    dependencies: { "pack-check-fixture-dep-zz9": "workspace:*" },
  });
  writeFileSync(
    join(root, "packages/app/index.js"),
    'export { dep } from "pack-check-fixture-dep-zz9";\n',
  );
  const install = Bun.spawn(["bun", "install"], { cwd: root, stdout: "ignore", stderr: "ignore" });
  expect(await install.exited).toBe(0);
  expect(await checkPackage(join(root, "packages/app"), () => {})).toEqual([]);
});

test("files accepts paths, directories, globs and exclusions", () => {
  expect(inFiles("dist/a.js", ["dist"])).toBe(true);
  expect(inFiles("dist/a/b.js", ["./dist/"])).toBe(true);
  expect(inFiles("lib/a.js", ["dist"])).toBe(false);
  expect(inFiles("dist/a/b.js", ["dist/**/*.js"])).toBe(true);
  expect(inFiles("dist/a.js.map", ["dist/**/*.js"])).toBe(false);
  expect(inFiles("tsconfig.json", ["tsconfig.json"])).toBe(true);
  expect(inFiles("dist/a.js.map", ["dist", "!**/*.map"])).toBe(false);
  expect(inFiles("src/a.ts", ["dist", "!**/*.map"])).toBe(false);
});

test("a file outside files, or a test file, is flagged", async () => {
  const dir = fixture(
    { ...good, name: "fixture-glob", files: ["dist/**/*.js"] },
    { "dist/index.js": "export {};\n", "dist/a.test.js": "export {};\n" },
  );
  expect((await checkPackage(dir, () => {})).join("\n")).toContain(
    "test in the tarball: dist/a.test.js",
  );
});

test("the manifest readers", () => {
  expect(
    unresolvedSpecs({
      dependencies: { a: "workspace:*", b: "^1" },
      peerDependencies: { c: "catalog:" },
    }),
  ).toEqual(["dependencies.a: workspace:*", "peerDependencies.c: catalog:"]);
  expect(
    fieldTargets({ bin: { x: "./bin/x.js" }, types: "./t.d.ts", main: "./m.js" }).sort(),
  ).toEqual(["./bin/x.js", "./m.js", "./t.d.ts"]);
  const entries = ["dist/i.js", "dist/i.d.ts", "dist/x/a.js", "package.json"];
  const { subpaths, problems } = resolveExports(
    {
      exports: {
        ".": { types: "./dist/i.d.ts", default: "./dist/i.js" },
        "./x/*": "./dist/x/*.js",
        "./gone": null,
      },
    },
    entries,
  );
  expect(problems).toEqual([]);
  expect([...subpaths.keys()].sort()).toEqual([".", "./x/a"]);
  expect(resolveExports({ exports: "./dist/missing.js" }, entries).problems).toHaveLength(1);
});
