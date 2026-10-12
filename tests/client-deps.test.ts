import { afterAll, expect, test } from "bun:test";
import { mkdir, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { useState } from "react";
import { build } from "../packages/core/src/build";
import { buildApp, openClient, startServer, TEST_TIMEOUT_MS } from "../packages/core/src/test";
import { compileClient } from "../packages/core/src/compile";
import { execute, exited, inPty, isolatedTemporary, until, WAIT_MS } from "./helpers";
import { existsSync, readFileSync } from "node:fs";
import type { Subprocess } from "bun";

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

test("all four core-owned Client packages are absent from the isolated app", async () => {
  for (const name of [
    "react-server-dom-webpack/client.browser",
    "react-reconciler",
    "@opentui/core",
    "@opentui/react",
  ]) {
    expect(() => Bun.resolveSync(name, directory)).toThrow();
    const entry = Bun.resolveSync(name, resolve("packages/core"));
    expect(entry).toContain("node_modules");
    const probe = join(directory, "probe.js");
    await Bun.write(probe, `await import(${JSON.stringify(name)});`);
    const missing = await execute([process.execPath, probe], { cwd: directory });
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr.toString()).toContain(`Cannot find module '${name}'`);
    // The installed Flight, reconciler and OpenTUI all use the app's peer React.
    expect(createRequire(entry)("react")).toBe(
      createRequire(join(directory, "package.json"))("react"),
    );
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

for (const mode of ["start", "compile"] as const)
  test(`the isolated Client renders through ${mode}`, async () => {
    await using server = await startServer(direct);
    const run = await isolatedTemporary(`luciole-client-${mode}-`);
    let child: Subprocess | undefined;
    try {
      const command =
        mode === "compile"
          ? `${(await compileClient(direct.output, { name: "isolated", outfile: join(run, "client"), runtime: "host" })).outfile} --url ${server.url}`
          : `${process.execPath} ${resolve("packages/core/src/cli.ts")} start --role client --app ${directory} --url ${server.url}`;
      const log = join(run, "screen.log");
      child = Bun.spawn(inPty(log, command), {
        cwd: run,
        env: { ...process.env, HOME: run, XDG_STATE_HOME: run, TERM: "xterm-256color" },
        stdout: "ignore",
        stderr: "ignore",
      });
      let screen = "";
      await until(
        () => {
          screen = existsSync(log) ? Bun.stripANSI(readFileSync(log, "utf8")) : "";
          return screen.includes("ISOLATED_CLIENT_RENDER");
        },
        WAIT_MS,
        () => screen,
      );
      await Bun.write(join(run, "stop"), "");
      expect(await exited(child)).toBe(0);
    } finally {
      if (child) {
        await Bun.write(join(run, "stop"), "");
        await exited(child).catch(() => {});
      }
      await rm(run, { recursive: true, force: true });
    }
  }, 60000);
