import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../packages/luciole/src/build";
import { compileApp } from "../packages/luciole/src/compile";
import { AppMetadata } from "../packages/luciole/src/app-metadata";
import { messageOf } from "../packages/luciole/src/guards";
import { launch, readManifest, rejectionOf, until } from "./helpers";

const cli = resolve("packages/luciole/src/cli.ts");
const ARGS = `import { defineArgs } from "luciole/args";
import { z } from "zod";
import { GREETING } from "../shared/greeting";
export default defineArgs({
  summary: "Greets someone",
  options: z.object({
    name: z.string().default(GREETING).meta({ short: "n", description: "Who to greet" }),
    dir: z.string().optional().meta({ kind: "path" }),
  }).strict(),
  examples: ["hello -n bob"],
});`;
const files: Record<string, string> = {
  "app/layout.tsx": `"use client";export default function Layout({children}){return children}`,
  // Read at module level: the Server parses its arguments before any page module runs.
  "app/page.tsx": `import cli from "./args";import {getArgs} from "luciole/server";
const {name,dir}=cli.get();
export default function Page(){return <text>{"HELLO "+name+" IN "+(dir ?? "-")+" SAME "+String(getArgs()===cli.get())}</text>}`,
  "app/args.ts": ARGS,
  "shared/greeting.ts": `export const GREETING = "world";`,
};

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "luciole-args-"));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await Bun.write(join(dir, name), text);
  }
  await symlink(resolve("node_modules"), join(dir, "node_modules"), "dir");
});
afterAll(() => rm(dir, { recursive: true, force: true }));

async function render(env: Record<string, string>) {
  const server = await launch(join(dir, ".luciole/server/index.js"), env);
  try {
    const manifest = await readManifest(dir);
    const response = await fetch(`${server.url}/render?route=%2F&params=%7B%7D`, {
      headers: { "x-luciole-build": manifest.buildId },
    });
    return await response.text();
  } finally {
    await server.stop();
  }
}

test("app/args.ts is bundled for launchers, described in metadata, parsed by the Server", async () => {
  const { buildId } = await build(dir);
  expect(await Bun.file(join(dir, ".luciole/args/index.js")).exists()).toBe(true);
  const metadata = AppMetadata.parse(await Bun.file(join(dir, ".luciole/metadata.json")).json());
  expect(metadata.args).toMatchObject({
    summary: "Greets someone",
    examples: ["hello -n bob"],
    schema: { properties: { name: { short: "n", default: "world" } } },
  });
  // Without arguments, the defaults; with them, the Server's own parse, typed.
  expect(await render({})).toContain("HELLO world IN - SAME true");
  expect(
    await render({
      LUCIOLE_ARGS: JSON.stringify({ v: 1, argv: ["-n", "bob", "--dir", "x"], cwd: "/w" }),
    }),
  ).toContain("HELLO bob IN /w/x");
  // The declaration is part of the build's identity.
  await Bun.write(join(dir, "shared/greeting.ts"), `export const GREETING = "you";`);
  expect((await build(dir)).buildId).not.toBe(buildId);
  await Bun.write(join(dir, "shared/greeting.ts"), `export const GREETING = "world";`);
}, 60000);

test("a Server given arguments it refuses exits with code 2 and says why", async () => {
  await build(dir);
  const child = spawn(
    process.execPath,
    ["--conditions=react-server", join(dir, ".luciole/server/index.js")],
    {
      env: {
        ...process.env,
        PORT: "0",
        LUCIOLE_ARGS: JSON.stringify({ v: 1, argv: ["--nam", "x"] }),
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let errors = "";
  child.stderr.on("data", (chunk: Buffer) => (errors += chunk.toString()));
  const code = await new Promise((done) => child.once("exit", done));
  expect(code).toBe(2);
  expect(errors).toContain("Unknown option --nam (did you mean --name?)");
}, 30000);

test("app/args.ts stays out of Server-only code and away from the runtime's flags", async () => {
  const refused = async (args: string, extra: Record<string, string> = {}) => {
    const other = await mkdtemp(join(tmpdir(), "luciole-args-bad-"));
    try {
      for (const [name, text] of Object.entries({ ...files, ...extra, "app/args.ts": args })) {
        await mkdir(join(other, name, ".."), { recursive: true });
        await Bun.write(join(other, name), text);
      }
      await symlink(resolve("node_modules"), join(other, "node_modules"), "dir");
      return messageOf(await rejectionOf(build(other)));
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  };
  expect(await refused(`import "server-only";\n${ARGS}`)).toContain(
    "app/args.ts runs in the launcher and on the Server: it cannot import server-only",
  );
  expect(
    await refused(`import {secret} from "../server/secret";\n${ARGS}`, {
      "server/secret.ts": "export const secret = 1;",
    }),
  ).toContain("cannot import ../server/secret");
  expect(await refused(ARGS.replace("dir:", "url:"))).toContain("--url is reserved by luciole");
  expect(await refused(`export default 1;`)).toContain("export default defineArgs");
}, 60000);

const luciole = (args: readonly string[]) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("exit", (code) => done({ code, stdout, stderr }));
  });

test("luciole dev and luciole ./app take the application's arguments and its --help", async () => {
  const help = await luciole(["dev", "--app", dir, "--", "--help"]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("-n, --name <value>");
  expect(help.stdout).toContain("Examples:\n  hello -n bob");
  const typo = await luciole(["dev", "--app", dir, "--", "--nme", "x"]);
  expect(typo).toMatchObject({ code: 2 });
  expect(typo.stderr).toContain("did you mean --name?");
  const launched = await luciole([dir, "--help"]);
  expect(launched.code).toBe(0);
  expect(launched.stdout).toContain("Runtime (luciole):");
  expect(launched.stdout).toContain("--grace <duration>");
  expect((await luciole([dir, "--nope"])).code).toBe(2);
  expect((await luciole([dir, "--url", "unix:/nowhere", "-n", "x"])).stderr).toContain(
    "application arguments configure a Server",
  );
}, 60000);

test("an app binary parses them too: its --help, serve -- options, and none with --url", async () => {
  const { output } = await build(dir);
  const { outfile } = await compileApp(output, {
    name: "hello",
    outfile: join(dir, "bin/hello"),
    runtime: "host",
  });
  const run = (...args: string[]) => Bun.spawnSync([outfile, ...args], { env: process.env });
  const help = run("--help");
  expect(help.exitCode).toBe(0);
  expect(help.stdout.toString()).toContain("-n, --name <value>");
  expect(help.stdout.toString()).toContain("--on <[user@]host>");
  const typo = run("--nme", "x");
  expect(typo.exitCode).toBe(2);
  expect(typo.stderr.toString()).toContain("did you mean --name?");
  expect(run("--url", "unix:/nowhere", "-n", "x").stderr.toString()).toContain(
    "application arguments configure a Server",
  );
  expect(run("serve", "--bogus").exitCode).toBe(2);
  // `serve -- options`: the Server alone, with its arguments.
  const socket = join(dir, "hello.sock");
  const server = spawn(outfile, ["serve", "--socket", socket, "--", "-n", "binary"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    await until(() => existsSync(socket), 20000);
    const manifest = await readManifest(dir);
    const body = await fetch("http://localhost/render?route=%2F&params=%7B%7D", {
      unix: socket,
      headers: { "x-luciole-build": manifest.buildId },
    });
    expect(await body.text()).toContain("HELLO binary");
  } finally {
    server.kill();
  }
}, 120000);
