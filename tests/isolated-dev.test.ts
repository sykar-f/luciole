import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { z } from "zod";
import { loadAppBundle } from "../packages/core/src/app-bundle";
import { openClient, startServer, TEST_TIMEOUT_MS } from "../packages/core/src/test";
import { execute, exited, inPty, isolatedTemporary, until, WAIT_MS } from "./helpers";

const directory = await isolatedTemporary("luciole-isolated-dev-");
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
  '"use client";import {useState} from "react";export function buildEnvironment(){return process.env.NODE_ENV}export function Counter(){const [value]=useState("ISOLATED_DEVELOPMENT_RENDER");return <text>{value}</text>}',
);
await Bun.write(
  join(directory, "app/args.ts"),
  'import {defineArgs} from "@luciole-sh/core/args";import {z} from "zod";export default defineArgs({summary:process.env.NODE_ENV??"unset",options:z.object({label:z.string().default("development")})});',
);
const hoisted = await isolatedTemporary("luciole-hoisted-dev-");
afterAll(() => rm(hoisted, { recursive: true, force: true }));
await symlink(resolve("node_modules"), join(hoisted, "node_modules"), "dir");
for (const name of ["app", "components", "package.json"])
  await cp(join(directory, name), join(hoisted, name), { recursive: true });
const env = { ...process.env, NODE_ENV: "development" };

for (const [installation, root] of [
  ["isolated", directory],
  ["hoisted", hoisted],
] as const)
  test(
    `${installation} app builds directly and renders with NODE_ENV=development`,
    async () => {
      if (installation === "isolated")
        expect(() => Bun.resolveSync("@opentui/react/jsx-dev-runtime", root)).toThrow();
      const script = join(root, "build.ts");
      await Bun.write(
        script,
        `import {build} from ${JSON.stringify(resolve("packages/core/src/build.ts"))};console.log(JSON.stringify(await build(${JSON.stringify(root)})));`,
      );
      const result = await execute([process.execPath, script], { cwd: root, env });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      const app = {
        directory: root,
        ...z
          .object({ output: z.string(), buildId: z.string() })
          .parse(JSON.parse(result.stdout.toString())),
      };
      expect(await Bun.file(join(app.output, "app/index.cjs")).text()).not.toContain(
        "jsx-dev-runtime",
      );
      const loaded = await loadAppBundle(join(app.output, "app"));
      expect(loaded.buildId).toBe(app.buildId);
      const environment = loaded.modules.get(
        `${app.buildId}/components/counter.tsx`,
      )?.buildEnvironment;
      if (typeof environment !== "function") throw new Error("Missing buildEnvironment export");
      expect(Reflect.apply(environment, undefined, [])).toBe(process.env.NODE_ENV);
      const argsScript = join(root, "args-probe.ts");
      await Bun.write(
        argsScript,
        `import cli from "./.luciole/args/index.js";console.log(cli.summary);`,
      );
      const args = await execute([process.execPath, argsScript], {
        cwd: root,
        env: { ...env, NODE_ENV: "production" },
      });
      expect(args.exitCode, args.stderr.toString()).toBe(0);
      expect(args.stdout.toString().trim()).toBe("production");
      await using server = await startServer(app, { NODE_ENV: "development" });
      await using client = await openClient(app, server);
      expect(await client.waitFor("ISOLATED_DEVELOPMENT_RENDER")).toContain(
        "ISOLATED_DEVELOPMENT_RENDER",
      );
    },
    TEST_TIMEOUT_MS,
  );

test(
  "luciole dev builds and renders an isolated app with NODE_ENV=development",
  async () => {
    await rm(join(directory, ".luciole"), { recursive: true, force: true });
    const run = await isolatedTemporary("luciole-isolated-dev-pty-");
    let child: Subprocess | undefined;
    try {
      const log = join(run, "screen.log");
      child = Bun.spawn(
        inPty(
          log,
          `${process.execPath} ${resolve("packages/core/src/cli.ts")} dev --app ${directory}`,
        ),
        {
          cwd: run,
          env: { ...env, HOME: run, XDG_STATE_HOME: run, TERM: "xterm-256color" },
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      let screen = "";
      await until(
        () => {
          screen = existsSync(log) ? Bun.stripANSI(readFileSync(log, "utf8")) : "";
          return screen.includes("ISOLATED_DEVELOPMENT_RENDER");
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
  },
  TEST_TIMEOUT_MS,
);
