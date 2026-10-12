import { afterAll, expect, test } from "bun:test";
import { mkdir, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { useState } from "react";
import { build } from "../packages/core/src/build";
import { buildApp, openClient, startServer, TEST_TIMEOUT_MS } from "../packages/core/src/test";
import { isolatedTemporary } from "./helpers";

// An isolated install exposes only the app's declared packages. Core's dependencies
// stay in core's real installation, with no ancestor node_modules to rescue the Client.
const directory = await isolatedTemporary("luciole-client-deps-");
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
    dependencies: { "@luciole-sh/core": "0.3.0", react: "^19.3.0", "react-dom": "^19.3.0" },
  }),
);
await Bun.write(
  join(directory, "app/layout.tsx"),
  '"use client";export default function Layout({children}){return children}',
);
await Bun.write(
  join(directory, "app/page.tsx"),
  'import {Counter} from "../components/counter";export default function Page(){return <Counter/>}',
);
await Bun.write(
  join(directory, "components/counter.tsx"),
  '"use client";import {useState} from "react";export {useState as peerUseState};export function Counter(){const [value]=useState("ISOLATED_CLIENT_RENDER");return <text>{value}</text>}',
);
const direct = { directory, ...(await build(directory)) };
const temporary = await buildApp(directory);

test("all four core-owned Client packages are absent from the isolated app", () => {
  for (const name of [
    "react-server-dom-webpack/client.browser",
    "react-reconciler",
    "@opentui/core",
    "@opentui/react",
  ]) {
    expect(() => Bun.resolveSync(name, directory)).toThrow();
    expect(Bun.resolveSync(name, resolve("packages/core"))).toContain("node_modules");
  }
});

for (const [location, app] of [
  ["application", direct],
  ["public test API", temporary],
] as const)
  test(
    `the isolated ${location} Client renders a hook component through Flight`,
    async () => {
      await using server = await startServer(app);
      await using client = await openClient(app, server);
      expect(await client.waitFor("ISOLATED_CLIENT_RENDER")).toContain("ISOLATED_CLIENT_RENDER");
      expect(
        client.app.options.resolveModule(`${app.buildId}/components/counter.tsx`).peerUseState,
      ).toBe(useState);
    },
    TEST_TIMEOUT_MS,
  );
