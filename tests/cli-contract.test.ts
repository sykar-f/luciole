import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFlags } from "../packages/core/src/commands/command";
import { execute } from "./helpers";

const cli = resolve("packages/core/src/cli.ts");
const luciolex = resolve("packages/core/src/luciolex.ts");
const luciole = (args: string[], cwd?: string) =>
  execute([process.execPath, cli, ...args], { cwd });

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "luciole-cli-"));
  await mkdir(join(dir, "app"), { recursive: true });
  await Bun.write(
    join(dir, "app/layout.tsx"),
    `"use client";export default function Layout({children}){return children}`,
  );
  await Bun.write(
    join(dir, "app/page.tsx"),
    `export default function Page(){return <text>hi</text>}`,
  );
  await symlink(resolve("node_modules"), join(dir, "node_modules"), "dir");
});
afterAll(() => rm(dir, { recursive: true, force: true }));

test("a flag that needs a value and gets none is a usage error naming it", async () => {
  for (const [args, flag] of [
    [["build", "--app"], "--app"],
    [["build", "--app", "--web"], "--app"],
    [["start", "--role"], "--role"],
    [["connect", "--artifact"], "--artifact"],
    [["start", "--role", "server", "--artifact", "--", "x"], "--artifact"],
  ] as const) {
    const run = await luciole([...args]);
    expect(run.exitCode).toBe(2);
    expect(run.stderr.toString()).toContain(`${flag} needs a value`);
  }
});

test("luciole's own flags stop at --", () => {
  const { flag, optional, rest } = readFlags(["build", "--web", "--", "--web-local", "--app", "x"]);
  expect(flag("--web")).toBe(true);
  expect(flag("--web-local")).toBe(false);
  // The application's `--app` is not luciole's: no value is missing, none is read.
  expect(optional("--app")).toBeUndefined();
  expect(rest).toEqual(["--web-local", "--app", "x"]);
});

test("a missing value is refused, and a value is read", () => {
  expect(() => readFlags(["start", "--role"]).optional("--role")).toThrow("--role needs a value");
  expect(readFlags(["start", "--role", "client"]).option("--role", "server")).toBe("client");
  expect(readFlags(["start"]).option("--role", "server")).toBe("server");
});

test("build targets the current directory without --app", async () => {
  const run = await luciole(["build"], dir);
  expect(run.exitCode).toBe(0);
  expect(await Bun.file(join(dir, ".luciole/server/index.js")).exists()).toBe(true);
});

test("luciolex exits with the usage code when it has no target", async () => {
  for (const args of [[], ["--yes"]]) {
    const run = await execute([process.execPath, luciolex, ...args]);
    expect(run.exitCode).toBe(2);
    expect(run.stderr.toString()).toContain("Usage: luciolex");
  }
});

test("--yes is luciole's before -- and the application's after it", async () => {
  const { takeYes } = await import("../packages/core/src/commands/launch");
  const own = takeYes(["--yes", "--verbose"]);
  expect(own.args).toEqual(["--verbose"]);
  expect(own.confirm).toHaveProperty("confirm");
  const theirs = takeYes(["--", "--yes"]);
  expect(theirs.args).toEqual(["--", "--yes"]);
  expect(theirs.confirm).toEqual({});
  const both = takeYes(["--yes", "--", "--yes"]);
  expect(both.args).toEqual(["--", "--yes"]);
  expect(both.confirm).toHaveProperty("confirm");
});

test("luciolex and luciole never read a --yes after -- as their own", async () => {
  // The application is refused its unknown `--yes`: it reached the application.
  for (const argv of [
    [cli, dir, "--", "--yes"],
    [luciolex, dir, "--", "--yes"],
  ]) {
    const run = await execute([process.execPath, ...argv]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("--yes");
  }
});
