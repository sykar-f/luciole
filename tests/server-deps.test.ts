import { afterAll, expect, test } from "bun:test";
import { mkdir, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { build } from "../packages/core/src/build";
import { buildApp } from "../packages/core/src/test/build";
import { startServer } from "../packages/core/src/test/server";
import { isolatedTemporary } from "./helpers";

// Only core and its React peers are visible to the application. Core's own
// dependencies resolve through its real installation, never through this directory.
const directory = await isolatedTemporary("luciole-server-deps-");
afterAll(() => rm(directory, { recursive: true, force: true }));
await mkdir(join(directory, "node_modules/@luciole-sh"), { recursive: true });
await symlink(resolve("packages/core"), join(directory, "node_modules/@luciole-sh/core"), "dir");
for (const name of ["react", "react-dom"])
  await symlink(
    dirname(Bun.resolveSync(`${name}/package.json`, resolve("packages/core"))),
    join(directory, "node_modules", name),
    "dir",
  );
await Bun.write(
  join(directory, "package.json"),
  JSON.stringify({
    type: "module",
    dependencies: { "@luciole-sh/core": "0.2.0", react: "^19.3.0", "react-dom": "^19.3.0" },
  }),
);
await Bun.write(
  join(directory, "app/layout.tsx"),
  '"use client";export default function Layout({children}){return children}',
);
await Bun.write(
  join(directory, "app/page.tsx"),
  "export default function Page(){return <text>ISOLATED_SERVER_RENDER</text>}",
);

const direct = await build(directory);
const temporary = await buildApp(directory);
for (const [location, app] of [
  ["application", direct],
  ["public test API", temporary],
] as const)
  test(`the Server renders from ${location} with only core and peers installed`, async () => {
    expect(() => Bun.resolveSync("react-server-dom-webpack/server.node", directory)).toThrow();
    expect(() => Bun.resolveSync("react-reconciler", directory)).toThrow();
    expect(() => Bun.resolveSync("@opentui/core", directory)).toThrow();
    for (const NODE_ENV of ["development", "production"]) {
      await using server = await startServer(app, { NODE_ENV });
      const response = await fetch(`${server.url}/render?route=%2F&params=%7B%7D`, {
        headers: { "x-luciole-build": app.buildId },
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("ISOLATED_SERVER_RENDER");
    }
  });
