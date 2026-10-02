import { afterAll, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import { createStarter, isInstalled } from "../packages/core/src/commands/init";
import { messageOf } from "../packages/core/src/guards";
import { stageStarter } from "../packages/create/scripts/starter";
import { BUILD_TEST_MS, rejectionOf } from "./helpers";

const workspace = resolve(import.meta.dir, "..");
const workspaceFramework = join(workspace, "packages/core");
const temp = await mkdtemp(join(tmpdir(), "luciole-init-test-"));
afterAll(() => rm(temp, { recursive: true, force: true }));

const Starter = z.object({ dependencies: z.record(z.string(), z.string()) });
const Vendored = z.looseObject({
  dependencies: z.record(z.string(), z.string()),
  scripts: z.unknown().optional(),
  exports: z.looseObject({ ".": z.looseObject({ types: z.string(), default: z.string() }) }),
});
const dependenciesOf = async (starter: string) =>
  Starter.parse(await Bun.file(join(starter, "package.json")).json()).dependencies;

async function run(cmd: string[], cwd: string) {
  const child = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, output: out + err };
}
/** A framework package installed the way a package manager lays out a scoped dependency. */
async function installedFramework(directory: string, manifest: Record<string, unknown>) {
  const framework = join(directory, "node_modules/@luciole-sh/core");
  await mkdir(framework, { recursive: true });
  await Bun.write(
    join(framework, "package.json"),
    JSON.stringify({ name: "@luciole-sh/core", ...manifest }),
  );
  return framework;
}

test("a framework root is installed when it lies inside node_modules", () => {
  expect(isInstalled("/app/node_modules/@luciole-sh/core")).toBe(true);
  expect(isInstalled("/home/me/node_modules_clone/packages/core")).toBe(false);
  // A workspace checked out beneath a node_modules ancestor is still the workspace.
  expect(isInstalled("/app/node_modules/clone/packages/core")).toBe(false);
  expect(isInstalled(workspaceFramework)).toBe(false);
});

test("installed, init runs the scaffolder at the framework's own version", async () => {
  const framework = await installedFramework(join(temp, "app"), { version: "4.5.6" });
  const target = join(temp, "installed-starter");
  const commands: string[][] = [];
  await createStarter({
    target,
    framework,
    workspace,
    run: async (command) => {
      commands.push(command);
      return 0;
    },
  });
  // `bunx @luciole-sh/create@4.5.6 <target>`: nothing is read from a tree around the framework.
  expect(commands).toEqual([[process.execPath, "x", "@luciole-sh/create@4.5.6", target]]);
  expect(await Bun.file(target).exists()).toBe(false);
});

test("installed, init refuses a framework without a version, and a failing scaffolder", async () => {
  const framework = await installedFramework(join(temp, "unversioned"), {});
  const target = join(temp, "refused-starter");
  const refused = await rejectionOf(
    createStarter({ target, framework, workspace, run: async () => 0 }),
  );
  expect(messageOf(refused)).toContain("no version");
  const versioned = await installedFramework(join(temp, "failing"), { version: "1.0.0" });
  const failed = await rejectionOf(
    createStarter({ target, framework: versioned, workspace, run: async () => 3 }),
  );
  expect(messageOf(failed)).toContain("exited 3");
});

test("from a workspace, init runs the scaffolder's own script, not the registry", async () => {
  const target = join(temp, "dry-starter");
  const commands: string[][] = [];
  await createStarter({
    target,
    framework: workspaceFramework,
    workspace,
    run: async (command) => {
      commands.push(command);
      return 0;
    },
  });
  expect(commands).toEqual([
    [process.execPath, join(workspace, "packages/create/scripts/stage.ts"), "--workspace", target],
  ]);
});

test(
  "from the workspace, a starter links the framework and installs the editor",
  async () => {
    const starter = join(temp, "workspace-starter");
    await createStarter({ target: starter, framework: workspaceFramework, workspace });
    const dependencies = await dependenciesOf(starter);
    expect(dependencies["@luciole-sh/core"]).toBe(`file:${workspaceFramework}`);
    expect(dependencies["@luciole-sh/markdown-editor"]).toBe("file:./vendor/markdown-editor");

    // The copy resolves without the workspace: no catalog:, nothing to build.
    const copy = Vendored.parse(
      await Bun.file(join(starter, "vendor/markdown-editor/package.json")).json(),
    );
    expect(JSON.stringify(copy)).not.toMatch(/catalog:|workspace:/);
    expect(copy.scripts).toBeUndefined();
    expect(copy.exports["."].types).toBe("./src/index.ts");
    expect(copy.exports["."].default).toBe("./src/index.ts");
    const ignored = z
      .object({ ignorePatterns: z.array(z.string()) })
      .parse(await Bun.file(join(starter, ".oxlintrc.json")).json());
    expect(ignored.ignorePatterns).toContain("vendor/**");

    const install = await run([process.execPath, "install"], starter);
    expect(install.output).toContain("@luciole-sh/markdown-editor@vendor/markdown-editor");
    expect(install.code).toBe(0);
    expect(
      await Bun.file(
        join(starter, "node_modules/@luciole-sh/markdown-editor/src/index.ts"),
      ).exists(),
    ).toBe(true);
  },
  BUILD_TEST_MS,
);

test("a workspace nested under a node_modules ancestor, or a test directory, is still vendored", async () => {
  const nested = join(temp, "node_modules/test-work/luciole");
  await cp(workspace, nested, {
    recursive: true,
    filter: (p) =>
      !/(^|\/)(node_modules|\.git|\.luciole|website|\.orchestra|template)(\/|$)/.test(
        relative(workspace, p),
      ),
  });
  const framework = join(nested, "packages/core");
  expect(isInstalled(framework)).toBe(false);
  const starter = join(temp, "nested-starter");
  // The scaffolder's staging resolves its formatter from this checkout, not from the copy.
  await stageStarter({ workspace: nested, target: starter, link: "workspace" });
  const dependencies = await dependenciesOf(starter);
  expect(dependencies["@luciole-sh/core"]).toBe(`file:${framework}`);
  expect(dependencies["@luciole-sh/markdown-editor"]).toBe("file:./vendor/markdown-editor");
  expect(await Bun.file(join(starter, "vendor/markdown-editor/src/index.ts")).exists()).toBe(true);
});
