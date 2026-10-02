import { test, expect } from "bun:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { workspaces } from "../package.json";
import framework from "../packages/core/package.json";

// Verify the renderer's real resolution: a stale nested reconciler can hide a failed upgrade.
test("OpenTUI uses the pinned reconciler and shares the application's React and Core", () => {
  const require = createRequire(import.meta.url);
  const rendererRequire = createRequire(require.resolve("@opentui/react"));
  const reconciler = z
    .object({ version: z.string() })
    .parse(
      JSON.parse(readFileSync(rendererRequire.resolve("react-reconciler/package.json"), "utf8")),
    );
  expect(reconciler.version).toBe(workspaces.catalog["react-reconciler"]);
  expect(rendererRequire("react")).toBe(require("react"));
  expect(rendererRequire.resolve("@opentui/core")).toBe(require.resolve("@opentui/core"));
});

// luciole does not use `catalog:`: a starter outside the workspace installs it from `file:` and
// could not resolve the catalog. What it publishes (dependencies, peers) is a caret range over
// the catalog's version, what it develops with (devDependencies) is the catalog's exact pin.
test("the luciole package ranges what the workspace catalog pins", () => {
  const catalog: Record<string, string> = workspaces.catalog;
  for (const [name, range] of Object.entries({
    ...framework.dependencies,
    ...framework.peerDependencies,
  })) {
    // react and react-dom are peers of the application, ranged by hand.
    if (name === "react" || name === "react-dom") continue;
    expect(`${name}@${range}`).toBe(`${name}@^${catalog[name]}`);
  }
  for (const [name, version] of Object.entries(framework.devDependencies))
    expect(`${name}@${version}`).toBe(`${name}@${catalog[name]}`);
});

test("every optional peer is declared optional, and kept as a development dependency", () => {
  const optional = Object.keys(framework.peerDependenciesMeta);
  for (const name of Object.keys(framework.peerDependencies)) {
    if (name === "react" || name === "react-dom") continue;
    expect(optional).toContain(name);
    expect(Object.keys(framework.devDependencies)).toContain(name);
  }
});
