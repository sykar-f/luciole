import { afterAll, expect, test } from "bun:test";
import { cp, mkdir, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  installSkills,
  packagedMaterial,
  type SkillsOptions,
} from "../packages/core/src/commands/skills";
import { stageStarter } from "../packages/create/scripts/starter";
import { execute, isolatedTemporary } from "./helpers";

const checkout = resolve(import.meta.dir, "..");
const temp = await isolatedTemporary("luciole-stage-starter-");
afterAll(() => rm(temp, { recursive: true, force: true }));

/**
 * A workspace of its own, so the build state is planted away from the live checkout: the
 * top-level files are copied (staging rewrites some of them), the directories linked, and
 * `examples/notes` copied without `node_modules`.
 */
async function workspaceWithBuildState(): Promise<string> {
  const workspace = join(temp, "workspace");
  await mkdir(join(workspace, "examples"), { recursive: true });
  for (const name of await readdir(checkout)) {
    if (["node_modules", ".git", "examples"].includes(name)) continue;
    const source = join(checkout, name);
    if ((await stat(source)).isDirectory()) await symlink(source, join(workspace, name));
    else await cp(source, join(workspace, name));
  }
  for (const name of await readdir(join(checkout, "examples"))) {
    const source = join(checkout, "examples", name);
    const copy = join(workspace, "examples", name);
    if (name === "notes")
      await cp(source, copy, {
        recursive: true,
        filter: (p) => !p.startsWith(join(source, "node_modules")),
      });
    else await symlink(source, copy);
  }
  const notes = join(workspace, "examples/notes");
  // What a build in progress leaves: the output, its lock naming a live process, a staging directory.
  await mkdir(join(notes, ".luciole"), { recursive: true });
  await mkdir(join(notes, ".luciole-lock"), { recursive: true });
  await writeFile(join(notes, ".luciole-lock/pid"), String(process.pid));
  await mkdir(join(notes, `.luciole-${crypto.randomUUID()}`), { recursive: true });
  return workspace;
}

test("a starter carries none of the example's build state", async () => {
  const workspace = await workspaceWithBuildState();
  const target = join(temp, "starter");
  await stageStarter({ workspace, target, link: "workspace" });
  const entries = await readdir(target);
  expect(entries.filter((name) => name.startsWith(".luciole"))).toEqual([]);
  expect(entries).toContain("app");
  expect(entries).toContain("package.json");
}, 60_000);

test("workspace init still installs the same material and prints the same lines", async () => {
  const expected = join(temp, "init-expected");
  await stageStarter({ workspace: checkout, target: expected, link: "workspace" });
  const entries = await readdir(expected);
  for (const name of ["AGENTS.md", "CLAUDE.md", ".agents", ".claude"])
    expect(entries).not.toContain(name);
  const logs: string[] = [];
  const options: SkillsOptions = {
    ...(await packagedMaterial()),
    directory: expected,
    home: temp,
    global: false,
    agents: ["agents", "claude"],
    dryRun: false,
    force: false,
    log: (line) => logs.push(line),
    warn: (line) => {
      throw new Error(line);
    },
  };
  await installSkills(options);
  const target = join(temp, "init-actual");
  const result = await execute(
    [process.execPath, join(checkout, "packages/core/src/cli.ts"), "init", target],
    {
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    },
  );
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stderr.toString()).toBe("");
  expect(result.stdout.toString()).toBe(
    `Starter created: ${target}\nRun bun install in the starter, then bun run dev.\n${logs.join("\n")}\n`,
  );
  for (const name of ["AGENTS.md", "CLAUDE.md", ".agents", ".claude"]) {
    const paths = name.endsWith(".md")
      ? [name]
      : (await readdir(join(expected, name), { recursive: true, withFileTypes: true }))
          .filter((entry) => entry.isFile())
          .map((entry) => relative(expected, join(entry.parentPath, entry.name)));
    for (const path of paths)
      expect(await Bun.file(join(target, path)).text(), path).toBe(
        await Bun.file(join(expected, path)).text(),
      );
  }
}, 60_000);
