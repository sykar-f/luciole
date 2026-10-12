import { afterAll, expect, test } from "bun:test";
import { cp, mkdir, readdir, rename, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { useState } from "react";
import { z } from "zod";
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
    expect(missing.stderr.toString()).toMatch(/Cannot find (module|package)/);
    expect(missing.stderr.toString()).toContain(name);
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

for (const builder of ["Client", "Server", "development shell"] as const)
  test(
    `a ${builder} builds a linked Client sharing renderer React despite a second app copy`,
    async () => {
      const linked = await isolatedTemporary("luciole-client-peers-");
      try {
        await mkdir(join(linked, "node_modules/@luciole-sh"), { recursive: true });
        await symlink(
          resolve("packages/core"),
          join(linked, "node_modules/@luciole-sh/core"),
          "dir",
        );
        for (const name of ["react", "react-dom"])
          await cp(
            dirname(Bun.resolveSync(`${name}/package.json`, resolve("packages/core"))),
            join(linked, "node_modules", name),
            { recursive: true, dereference: true },
          );
        for (const name of ["app", "components", "package.json"])
          await cp(join(directory, name), join(linked, name), { recursive: true });
        // Keep the router namespace visible: its export-only RSC entry otherwise
        // disappears during tree shaking even when it was selected incorrectly.
        await Bun.write(
          join(linked, "components/counter.tsx"),
          `${await Bun.file(join(linked, "components/counter.tsx")).text()};import * as router from "@tanstack/react-router";export {router};`,
        );
        const appRequire = createRequire(join(linked, "package.json"));
        const rendererRequire = createRequire(
          Bun.resolveSync("@opentui/react", resolve("packages/core")),
        );
        const ReactPeer = z.object({
          version: z.string(),
          useState: z.custom<typeof useState>((value) => typeof value === "function"),
        });
        const appReact: unknown = appRequire("react");
        const rendererReact: unknown = rendererRequire("react");
        const rendererPeer = ReactPeer.parse(rendererReact);
        // Same version, different physical installation: the peer split is real.
        expect(ReactPeer.parse(appReact).version).toBe(rendererPeer.version);
        expect(appReact).not.toBe(rendererReact);
        let result: { buildId: string; output: string };
        if (builder !== "Client") {
          const probe = join(linked, "build-probe.ts");
          const metadata = join(linked, "build-result.json");
          await Bun.write(
            probe,
            `import {build} from ${JSON.stringify(resolve("packages/core/src/build.ts"))};await Bun.write(${JSON.stringify(metadata)},JSON.stringify(await build(${JSON.stringify(linked)})));`,
          );
          const condition = builder === "Server" ? "react-server" : "development";
          const run = await execute([process.execPath, `--conditions=${condition}`, probe], {
            cwd: linked,
            env: { ...process.env, NODE_ENV: "production" },
          });
          expect(run.exitCode, run.stderr.toString()).toBe(0);
          result = z
            .object({ buildId: z.string(), output: z.string() })
            .parse(await Bun.file(metadata).json());
        } else result = await build(linked);
        const clientBundle = await Bun.file(join(result.output, "client/index.js")).text();
        expect(clientBundle.includes("@tanstack/react-router/dist/esm/index.js")).toBe(true);
        expect(clientBundle.includes(".rsc.")).toBe(false);
        expect(clientBundle.includes("@tanstack/react-router/dist/esm/index.dev.js")).toBe(false);
        const built = { directory: linked, ...result };
        await using server = await startServer(built);
        await using client = await openClient(built, server);
        expect(
          client.app.options.resolveModule(`${built.buildId}/components/counter.tsx`).peerUseState,
        ).toBe(rendererPeer.useState);
        expect(await client.waitFor("ISOLATED_CLIENT_RENDER")).toContain("ISOLATED_CLIENT_RENDER");
      } finally {
        await rm(linked, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

test(
  "Client export maps select nested subpaths and ignore unrelated shapes",
  async () => {
    const root = await isolatedTemporary("luciole-client-exports-");
    const core = join(root, "node_modules/@luciole-sh/core");
    try {
      await cp(resolve("packages/core"), core, {
        recursive: true,
        filter: (path) =>
          !relative(resolve("packages/core"), path).split("/").includes("node_modules"),
      });
      await cp(resolve("bun.lock"), join(root, "bun.lock"));
      const dependencies = join(core, "node_modules");
      await mkdir(dependencies);
      for (const entry of await readdir(resolve("node_modules"))) {
        if (entry.startsWith(".")) continue;
        if (entry === "react-dom")
          await cp(
            dirname(Bun.resolveSync("react-dom/package.json", resolve("packages/core"))),
            join(dependencies, entry),
            { recursive: true, dereference: true },
          );
        else await symlink(resolve("node_modules", entry), join(dependencies, entry), "dir");
      }
      // The graph's preflight resolves app imports before the role plugin runs.
      await symlink(join(dependencies, "react-dom"), join(root, "node_modules/react-dom"), "dir");
      const manifest = join(dependencies, "react-dom/package.json");
      const pkg = z
        .object({ exports: z.record(z.string(), z.unknown()) })
        .passthrough()
        .parse(await Bun.file(manifest).json());
      pkg.exports["./client-probe"] = {
        "react-server": "./wrong-probe.js",
        import: {
          development: "./wrong-probe.js",
          bun: "./client-probe.js",
          default: "./wrong-probe.js",
        },
      };
      pkg.exports["./literal-probe"] = "./literal-probe.js";
      pkg.exports["./pattern/*"] = { import: "./pattern/*.js" };
      pkg.exports["./unrelated"] = 42;
      pkg.exports["./no-client"] = { "react-server": "./wrong-probe.js" };
      pkg.exports["./blocked"] = {
        "react-server": "./wrong-probe.js",
        bun: null,
        default: "./wrong-probe.js",
      };
      await Bun.write(manifest, JSON.stringify(pkg));
      for (const name of ["client-probe", "literal-probe", "pattern/example", "wrong-probe"])
        await Bun.write(
          join(dependencies, `react-dom/${name}.js`),
          'export const value="CLIENT_EXPORT_PROBE";',
        );
      await Bun.write(
        join(root, "app/layout.tsx"),
        '"use client";export default function Layout({children}){return children}',
      );
      await Bun.write(
        join(root, "app/page.tsx"),
        'import {Probe} from "../components/probe";export default function Page(){return <Probe/>}',
      );
      await Bun.write(
        join(root, "components/probe.ts"),
        '"use client";export {value as nested} from "react-dom/client-probe";export {value as literal} from "react-dom/literal-probe";export {value as pattern} from "react-dom/pattern/example";export {default as metadata} from "react-dom/package.json";export function Probe(){return null}',
      );
      const probe = join(root, "build-probe.ts");
      await Bun.write(
        probe,
        `import {build} from ${JSON.stringify(join(core, "src/build.ts"))};await build(${JSON.stringify(root)});`,
      );
      const run = await execute(
        [process.execPath, "--conditions=react-server", "--conditions=development", probe],
        { cwd: root },
      );
      expect(run.exitCode, run.stderr.toString()).toBe(0);
      const bundle = await Bun.file(join(root, ".luciole/client/index.js")).text();
      for (const name of [
        "client-probe.js",
        "literal-probe.js",
        "pattern/example.js",
        "package.json",
      ])
        expect(bundle.includes(`react-dom/${name}`)).toBe(true);
      expect(bundle.includes("wrong-probe.js")).toBe(false);
      for (const subpath of ["no-client", "blocked"]) {
        await Bun.write(
          join(root, "components/probe.ts"),
          `"use client";export {value} from "react-dom/${subpath}";export function Probe(){return null}`,
        );
        const missing = await execute([process.execPath, "--conditions=react-server", probe], {
          cwd: root,
        });
        expect(missing.exitCode).not.toBe(0);
        expect(missing.stderr.toString()).toContain(
          `No export for react-dom/${subpath} under conditions bun, node, import`,
        );
      }
      // A package may export its root as a single string, without a subpath map.
      await Bun.write(manifest, JSON.stringify({ ...pkg, exports: "./literal-probe.js" }));
      await Bun.write(
        join(root, "components/probe.ts"),
        '"use client";export {value} from "react-dom";export function Probe(){return null}',
      );
      const literal = await execute([process.execPath, probe], { cwd: root });
      expect(literal.exitCode, literal.stderr.toString()).toBe(0);
      expect(
        (await Bun.file(join(root, ".luciole/client/index.js")).text()).includes(
          "react-dom/literal-probe.js",
        ),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  TEST_TIMEOUT_MS,
);

for (const mode of ["start", "compile"] as const)
  test(`the isolated Client renders through ${mode}`, async () => {
    await using server = await startServer(direct, { NODE_ENV: "production" });
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
        env: {
          ...process.env,
          HOME: run,
          XDG_STATE_HOME: run,
          NODE_ENV: "production",
          TERM: "xterm-256color",
        },
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

const CacheRecord = z
  .object({
    buildId: z.string(),
    options: z.object({ clientInstallation: z.string().optional() }).passthrough(),
  })
  .passthrough();

for (const mode of ["build", "dev"] as const)
  test(`a moved isolated installation rebuilds its Client through ${mode}`, async () => {
    const container = await isolatedTemporary("luciole-client-move-");
    const before = join(container, "before");
    const after = join(container, "after");
    let child: Subprocess | undefined;
    try {
      await mkdir(join(before, "node_modules/@luciole-sh"), { recursive: true });
      const core = join(before, "node_modules/@luciole-sh/core");
      await cp(resolve("packages/core"), core, {
        recursive: true,
        filter: (path) =>
          !relative(resolve("packages/core"), path).split("/").includes("node_modules"),
      });
      const dependencies = join(core, "node_modules");
      await mkdir(dependencies);
      // Other dependencies stay installed; the four absolute Client externals move
      // physically with core. Relative imports inside each copied package remain intact.
      for (const entry of await readdir(resolve("node_modules"))) {
        if (entry.startsWith(".")) continue;
        const names = entry.startsWith("@")
          ? (await readdir(resolve("node_modules", entry))).map((name) => `${entry}/${name}`)
          : [entry];
        for (const name of names) {
          const target = join(dependencies, name);
          await mkdir(dirname(target), { recursive: true });
          if (
            [
              "react-server-dom-webpack",
              "react-reconciler",
              "@opentui/core",
              "@opentui/react",
            ].includes(name)
          ) {
            const source = dirname(
              Bun.resolveSync(`${name}/package.json`, resolve("packages/core")),
            );
            await cp(source, target, {
              recursive: true,
              dereference: true,
              filter: (path) => !relative(source, path).split("/").includes("node_modules"),
            });
          } else await symlink(resolve("node_modules", name), target, "dir");
        }
      }
      for (const name of ["react", "react-dom"])
        await symlink(
          dirname(Bun.resolveSync(`${name}/package.json`, resolve("packages/core"))),
          join(before, "node_modules", name),
          "dir",
        );
      for (const name of ["app", "components", "package.json"])
        await cp(join(directory, name), join(before, name), { recursive: true });
      await cp(resolve("bun.lock"), join(before, "bun.lock"));
      const rebuild = async (root: string) => {
        const result = await execute(
          [
            process.execPath,
            join(root, "node_modules/@luciole-sh/core/src/cli.ts"),
            "build",
            "--app",
            root,
          ],
          { cwd: root },
        );
        expect(result.exitCode, result.stderr.toString()).toBe(0);
      };
      await rebuild(before);
      const manifest = join(before, ".luciole/manifest.json");
      const initial = CacheRecord.parse(await Bun.file(manifest).json());
      // Decode a manifest in its previous form: missing installation metadata is
      // accepted as an old cache record, but cannot make the Client up to date.
      delete initial.options.clientInstallation;
      await Bun.write(manifest, JSON.stringify(initial));
      const clientFile = join(before, ".luciole/client/index.js");
      await Bun.write(clientFile, (await Bun.file(clientFile).text()) + "\n// OLD_CACHE_RECORD");
      await rebuild(before);
      expect(await Bun.file(clientFile).text()).not.toContain("OLD_CACHE_RECORD");
      const prior = CacheRecord.parse(await Bun.file(manifest).json());
      expect(prior.options.clientInstallation).toBe(join(core, "src"));
      expect(await Bun.file(clientFile).text()).toContain(core);
      await rename(before, after);
      if (mode === "build") await rebuild(after);
      const relocatedCore = join(after, "node_modules/@luciole-sh/core");
      const cli = join(relocatedCore, "src/cli.ts");
      await using server =
        mode === "build"
          ? await startServer({ output: join(after, ".luciole") }, { NODE_ENV: "production" })
          : undefined;
      const log = join(container, "screen.log");
      const command = `${process.execPath} ${cli} ${mode === "dev" ? "dev" : `start --role client --url ${server?.url}`} --app ${after}`;
      child = Bun.spawn(inPty(log, command), {
        cwd: container,
        env: {
          ...process.env,
          HOME: container,
          XDG_STATE_HOME: container,
          TERM: "xterm-256color",
          // dev preserves the default environment; start selects production.
          NODE_ENV: mode === "dev" ? undefined : "production",
        },
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
      const moved = CacheRecord.parse(await Bun.file(join(after, ".luciole/manifest.json")).json());
      expect(moved.buildId).toBe(prior.buildId);
      expect(moved.options.clientInstallation).toBe(join(relocatedCore, "src"));
      expect(await Bun.file(join(after, ".luciole/client/index.js")).text()).not.toContain(core);
      if (mode === "dev") {
        await Bun.write(
          join(after, "components/counter.tsx"),
          (await Bun.file(join(after, "components/counter.tsx")).text()).replace(
            "ISOLATED_CLIENT_RENDER",
            "DEV_REBUILD_RENDER",
          ),
        );
        await until(
          () => {
            screen = existsSync(log) ? Bun.stripANSI(readFileSync(log, "utf8")) : "";
            return screen.includes("DEV_REBUILD_RENDER");
          },
          WAIT_MS,
          () => screen,
        );
      }
      await Bun.write(join(container, "stop"), "");
      expect(await exited(child)).toBe(0);
    } finally {
      if (child) {
        await Bun.write(join(container, "stop"), "");
        await exited(child).catch(() => {});
      }
      await rm(container, { recursive: true, force: true });
    }
  }, 60000);
