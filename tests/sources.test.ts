import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { lucioleSources } from "../packages/core/src/sources";

const SOURCES = resolve("packages/core/src");

test("luciole's sources: the calling module's directory when it is them", () => {
  expect(lucioleSources(SOURCES)).toBe(SOURCES);
});

test("bundled into an app, luciole's sources are found through the app's node_modules", () => {
  // An app's build output, as `luciole dev` or studio leave it: node_modules links to the
  // framework's packages, the bundle sits two levels below.
  const app = mkdtempSync(join(tmpdir(), "luciole-sources-"));
  try {
    const bundle = join(app, ".luciole/server");
    mkdirSync(bundle, { recursive: true });
    symlinkSync(resolve("node_modules"), join(app, "node_modules"), "dir");
    expect(lucioleSources(bundle)).toBe(SOURCES);
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});
