import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Command, declared, readFlags } from "../packages/core/src/commands/command";
import { messageOf } from "../packages/core/src/guards";
import { execute, rejectionOf } from "./helpers";

const cli = resolve("packages/core/src/cli.ts");
const luciolex = resolve("packages/core/src/luciolex.ts");
const luciole = (args: string[], cwd?: string) =>
  execute([process.execPath, cli, ...args], { cwd });

let dir: string, withArgs: string;
/** An app in `directory`, with `app/args.ts` when `args` is given. */
async function writeApp(directory: string, args?: string) {
  await mkdir(join(directory, "app"), { recursive: true });
  await Bun.write(
    join(directory, "app/layout.tsx"),
    `"use client";export default function Layout({children}){return children}`,
  );
  await Bun.write(
    join(directory, "app/page.tsx"),
    `export default function Page(){return <text>hi</text>}`,
  );
  if (args) await Bun.write(join(directory, "app/args.ts"), args);
  await symlink(resolve("node_modules"), join(directory, "node_modules"), "dir");
}
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "luciole-cli-"));
  withArgs = await mkdtemp(join(tmpdir(), "luciole-cli-args-"));
  await writeApp(dir);
  await writeApp(
    withArgs,
    `import { defineArgs } from "@luciole-sh/core/args";
import { z } from "zod";
export default defineArgs({
  summary: "Reads or asks",
  options: z.object({ mode: z.enum(["read", "ask"]).default("read") }).strict(),
});`,
  );
});
afterAll(() =>
  Promise.all([dir, withArgs].map((each) => rm(each, { recursive: true, force: true }))),
);

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

test("every usage error exits with code 2 and says what is wrong", async () => {
  for (const [args, message] of [
    [["install"], "Usage: luciole install"],
    [["remove"], "Usage: luciole remove"],
    [["pack"], "Usage: luciole pack"],
    [["pack", "--package", "x", "--version", "1.0.0"], "Usage: luciole pack"],
    [["trust"], "Usage: luciole trust"],
    [["trust", "https://example.com"], "Usage: luciole trust"],
    [["--nope"], "Usage: luciole"],
  ] as const) {
    const run = await luciole([...args]);
    expect(run.exitCode).toBe(2);
    expect(run.stderr.toString()).toContain(message);
  }
});

test("the flags of --compile are refused without it, before any build", async () => {
  for (const args of [
    ["--name", "x"],
    ["--client-only"],
    ["--target", "bun-linux-x64"],
    ["--runtime", "host"],
    ["--portable"],
    ["--native-dir", "native"],
    ["--outfile", "out"],
    ["--sign", "identity"],
    ["--notarize", "profile"],
  ]) {
    const run = await luciole(["build", ...args], dir);
    expect(run.exitCode).toBe(2);
    expect(run.stderr.toString()).toContain(`${args[0]} only applies with --compile`);
  }
  expect(await Bun.file(join(dir, ".luciole/server/index.js")).exists()).toBe(false);
});

test("a flag the command does not declare is a usage error naming it, before it runs", async () => {
  for (const [args, message] of [
    [["build", "--wbe"], "Unknown flag --wbe for luciole build (did you mean --web?)"],
    [["dev", "--ap", "."], "Unknown flag --ap for luciole dev (did you mean --app?)"],
    [["install", "--yse", "x"], "Unknown flag --yse for luciole install (did you mean --yes?)"],
    [["keys", "--force"], "Unknown flag --force for luciole keys"],
    [["start", "--verbose", "--", "--verbose"], "Unknown flag --verbose for luciole start"],
  ] as const) {
    const run = await luciole([...args], dir);
    expect(run.exitCode).toBe(2);
    expect(run.stderr.toString()).toContain(message);
    expect(run.stderr.toString()).toContain(`Usage: luciole ${args[0]}`);
  }
  expect(await Bun.file(join(dir, ".luciole/server/index.js")).exists()).toBe(false);
});

test("a declared command reads its own flags, skips their values and leaves -- alone", async () => {
  const seen: string[] = [];
  const raw: Command = {
    usage: "probe [--name n] [--dry]",
    flags: { "--name": "value", "--dry": "switch" },
    run: ({ optional, flag, rest }) => {
      seen.push(`${optional("--name")} ${flag("--dry")} ${rest.join(" ")}`);
      return Promise.resolve();
    },
  };
  const run = (args: string[], command: Command) =>
    declared("probe", command).run({ ...readFlags(args), args, directory: "." });
  await run(["probe", "--name", "-x", "--dry", "--", "--other"], raw);
  expect(seen).toEqual(["-x true --other"]);
  expect(() => run(["probe", "--nmae", "x"], raw)).toThrow("(did you mean --name?)");
  // A command that hands the other words to the application refuses none of them.
  await run(["probe", "--other"], { ...raw, forwards: true });
  // Reading a flag it does not declare, or a switch as a value, is the command's bug.
  const reading = (read: (context: Parameters<Command["run"]>[0]) => unknown) =>
    run(["probe"], { ...raw, run: async (context) => void read(context) });
  expect(messageOf(await rejectionOf(reading(({ flag }) => flag("--other"))))).toContain(
    "reads --other without",
  );
  expect(messageOf(await rejectionOf(reading(({ optional }) => optional("--dry"))))).toContain(
    "reads --dry as a value without",
  );
  expect(messageOf(await rejectionOf(reading(({ directory }) => directory)))).toContain(
    "reads --app as a value without",
  );
});

test("an app's arguments still reach it, before -- for luciole <target>, after it for dev", async () => {
  // luciole <target> refuses no flag itself: the app's parser does, with its own message.
  const unknown = await luciole([dir, "--wbe"]);
  expect(unknown.exitCode).toBe(2);
  expect(unknown.stderr.toString()).toContain("Unknown argument --wbe");
  expect(unknown.stderr.toString()).toContain("declares no arguments (app/args.ts)");
  const declaredBefore = await luciole([withArgs, "--mode", "wrong"]);
  expect(declaredBefore.exitCode).toBe(2);
  expect(declaredBefore.stderr.toString()).toContain("--mode");
  const help = await luciole([withArgs, "--help"]);
  expect(help.exitCode).toBe(0);
  expect(help.stdout.toString()).toContain("--mode");
  const afterDashes = await luciole(["dev", "--app", withArgs, "--", "--mode", "wrong"]);
  expect(afterDashes.exitCode).toBe(2);
  expect(afterDashes.stderr.toString()).toContain("--mode");
}, 60000);

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

test("build and dev print a stale-skills notice on stderr, and change no exit code", async () => {
  const manifest = join(dir, ".agents/skills/.luciole-skills.json");
  const dated = JSON.stringify({ version: "0.0.1", files: {} });
  await Bun.write(manifest, dated);
  await Bun.write(join(withArgs, ".claude/skills/.luciole-skills.json"), dated);
  try {
    const env = { ...process.env, CI: "" };
    const built = await execute([process.execPath, cli, "build"], { cwd: dir, env });
    expect(built.exitCode).toBe(0);
    expect(built.stderr.toString()).toContain("agent skills in this app are from luciole 0.0.1");
    // dev stops on a refused argument: still exit code 2, the notice before it.
    const refused = await execute(
      [process.execPath, cli, "dev", "--app", withArgs, "--", "--mode", "wrong"],
      { env },
    );
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr.toString()).toContain("run luciole skills to update them");
    const quiet = await execute([process.execPath, cli, "build"], {
      cwd: dir,
      env: { ...process.env, CI: "true" },
    });
    expect(quiet.exitCode).toBe(0);
    expect(quiet.stderr.toString()).not.toContain("agent skills");
  } finally {
    await rm(join(dir, ".agents"), { recursive: true, force: true });
    await rm(join(withArgs, ".claude"), { recursive: true, force: true });
  }
}, 60000);
