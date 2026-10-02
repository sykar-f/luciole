import { afterAll, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import { createStarter, isInstalled } from "../packages/core/src/commands/init";

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

test("a framework root is installed when it lies inside node_modules", () => {
  expect(isInstalled("/app/node_modules/@luciole-sh/core")).toBe(true);
  expect(isInstalled("/home/me/node_modules_clone/packages/core")).toBe(false);
  // A workspace checked out beneath a node_modules ancestor is still the workspace.
  expect(isInstalled("/app/node_modules/clone/packages/core")).toBe(false);
  expect(isInstalled(workspaceFramework)).toBe(false);
});

test("run from an installed package, a starter asks for its published version", async () => {
  const framework = join(temp, "app/node_modules/@luciole-sh/core");
  await mkdir(framework, { recursive: true });
  await Bun.write(
    join(framework, "package.json"),
    JSON.stringify({ name: "@luciole-sh/core", version: "4.5.6" }),
  );
  const starter = join(temp, "installed-starter");
  await createStarter({ target: starter, framework, workspace });
  const dependencies = await dependenciesOf(starter);
  expect(dependencies["@luciole-sh/core"]).toBe("^4.5.6");
  // The editor's own version, not the framework's.
  expect(dependencies["@luciole-sh/markdown-editor"]).toBe("^0.1.0");
  expect(
    Object.values(dependencies).filter((range) => /^(workspace|file|catalog):/.test(range)),
  ).toEqual([]);
  expect(await Bun.file(join(starter, "vendor")).exists()).toBe(false);
});

test("run from the workspace, a starter links the framework and installs the editor", async () => {
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
    await Bun.file(join(starter, "node_modules/@luciole-sh/markdown-editor/src/index.ts")).exists(),
  ).toBe(true);
}, 120_000);

test("a workspace nested under a node_modules ancestor, or a test directory, is still vendored", async () => {
  const nested = join(temp, "node_modules/test-work/luciole");
  await cp(workspace, nested, {
    recursive: true,
    filter: (p) =>
      !/(^|\/)(node_modules|\.git|\.luciole|website|\.orchestra)(\/|$)/.test(
        relative(workspace, p),
      ),
  });
  const starter = join(temp, "nested-starter");
  await createStarter({
    target: starter,
    framework: join(nested, "packages/core"),
    workspace: nested,
  });
  const dependencies = await dependenciesOf(starter);
  expect(dependencies["@luciole-sh/core"]).toBe(`file:${join(nested, "packages/core")}`);
  expect(dependencies["@luciole-sh/markdown-editor"]).toBe("file:./vendor/markdown-editor");
  expect(await Bun.file(join(starter, "vendor/markdown-editor/src/index.ts")).exists()).toBe(true);
});

test("installed, a workspace package the tree does not hold takes the framework's version", async () => {
  const framework = join(temp, "bare/node_modules/@luciole-sh/core");
  await mkdir(framework, { recursive: true });
  await Bun.write(
    join(framework, "package.json"),
    JSON.stringify({ name: "@luciole-sh/core", version: "7.8.9" }),
  );
  // A tree with the Notes example and its configuration, but no packages/ directory.
  const bare = join(temp, "bare/tree");
  await mkdir(bare, { recursive: true });
  for (const name of [
    "examples/notes",
    "package.json",
    ".oxlintrc.json",
    ".oxfmtrc.json",
    ".vscode",
    ".gitignore",
    ".bun-version",
  ])
    await cp(join(workspace, name), join(bare, name), { recursive: true });
  const starter = join(temp, "bare-starter");
  await createStarter({ target: starter, framework, workspace: bare });
  const dependencies = await dependenciesOf(starter);
  expect(dependencies["@luciole-sh/core"]).toBe("^7.8.9");
  expect(dependencies["@luciole-sh/markdown-editor"]).toBe("^7.8.9");
});
