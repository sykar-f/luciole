import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { airttySources } from "../packages/airtty/src/sources";

const SOURCES = resolve("packages/airtty/src");

test("airtty's sources: the calling module's directory when it is them", () => {
  expect(airttySources(SOURCES)).toBe(SOURCES);
});

test("bundled into an app, airtty's sources are found through the app's node_modules", () => {
  // An app's build output, as `airtty dev` or studio leave it: node_modules links to the
  // framework's packages, the bundle sits two levels below.
  const app = mkdtempSync(join(tmpdir(), "airtty-sources-"));
  try {
    const bundle = join(app, ".airtty/server");
    mkdirSync(bundle, { recursive: true });
    symlinkSync(resolve("node_modules"), join(app, "node_modules"), "dir");
    expect(airttySources(bundle)).toBe(SOURCES);
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});
