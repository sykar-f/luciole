import { afterAll, expect, test } from "bun:test";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { messageOf } from "../packages/core/src/guards";
import { stageStarter } from "../packages/create/scripts/starter";
import { BUILD_TEST_MS, isolatedTemporary, rejectionOf } from "./helpers";

const workspace = resolve(import.meta.dir, "..");
const temp = await isolatedTemporary("luciole-create-test-");
afterAll(() => rm(temp, { recursive: true, force: true }));

const Starter = z.looseObject({
  dependencies: z.record(z.string(), z.string()),
  devDependencies: z.record(z.string(), z.string()),
});
const readStarter = async (directory: string) =>
  Starter.parse(await Bun.file(join(directory, "package.json")).json());

async function run(cmd: string[], cwd: string) {
  const child = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, output: out + err };
}
/** `bun pm pack` of a workspace package: the tarball's path (`prepack` runs). */
async function pack(directory: string, destination: string): Promise<string> {
  await mkdir(destination, { recursive: true });
  const packed = await run(
    [process.execPath, "pm", "pack", "--destination", destination],
    directory,
  );
  expect(packed.code, packed.output).toBe(0);
  const [tarball] = await readdir(destination);
  return join(destination, z.string().parse(tarball));
}

// The tarball of @luciole-sh/create, packed once for the tests that follow.
const createTarball = await pack(join(workspace, "packages/create"), join(temp, "tarballs/create"));
/** The starter's dependency fields that name where a package comes from rather than a range. */
const unresolved = (dependencies: Record<string, string>) =>
  Object.values(dependencies).filter((range) => /^(workspace|catalog|file|link):/.test(range));

test(
  "the tarball's bin creates a standalone starter, with no checkout above it",
  async () => {
    const consumer = join(temp, "consumer");
    await mkdir(consumer);
    const added = await run([process.execPath, "add", createTarball], consumer);
    expect(added.code, added.output).toBe(0);
    const starter = join(consumer, "my-app");
    const created = await run(
      [join(consumer, "node_modules/.bin/create-luciole"), "my-app"],
      consumer,
    );
    expect(created.code, created.output).toBe(0);

    const manifest = await readStarter(starter);
    const version = z
      .object({ version: z.string() })
      .parse(await Bun.file(join(workspace, "packages/core/package.json")).json()).version;
    // Core and the editor are released together: both ask for this release.
    expect(manifest.dependencies["@luciole-sh/core"]).toBe(`^${version}`);
    expect(manifest.dependencies["@luciole-sh/markdown-editor"]).toBe(`^${version}`);
    for (const dependencies of [manifest.dependencies, manifest.devDependencies])
      expect(unresolved(dependencies)).toEqual([]);
    expect(await Bun.file(join(starter, "package.json")).text()).not.toMatch(
      /workspace:|catalog:|file:/,
    );
    // A deliberate list of tools, not the framework's whole development set.
    expect(Object.keys(manifest.devDependencies).sort()).toEqual([
      "@types/bun",
      "@types/react",
      "oxfmt",
      "oxlint",
      "oxlint-tsgolint",
      "typescript",
    ]);
    // The root configuration is inlined, and the packed `gitignore` is a `.gitignore` again.
    for (const file of [
      ".oxlintrc.json",
      ".oxfmtrc.json",
      ".vscode/settings.json",
      ".gitignore",
      ".bun-version",
      "tsconfig.json",
      "app/layout.tsx",
    ])
      expect(await Bun.file(join(starter, file)).exists(), file).toBe(true);
    expect(await Bun.file(join(starter, "gitignore")).exists()).toBe(false);
    expect(await readdir(starter)).not.toContain("vendor");

    const again = await run(
      [join(consumer, "node_modules/.bin/create-luciole"), "my-app"],
      consumer,
    );
    expect(again.code).toBe(1);
    expect(again.output).toContain("Target already contains a project");
  },
  BUILD_TEST_MS,
);

test("staging a workspace whose packages are out of lockstep, or absent, stops", async () => {
  // A tree with the Notes example and its configuration, but no packages/ directory.
  const bare = join(temp, "bare");
  await mkdir(bare);
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
  // Not guessed from the framework's version: the package is not there.
  expect(
    messageOf(
      await rejectionOf(
        stageStarter({ workspace: bare, target: join(temp, "bare-starter"), link: "published" }),
      ),
    ),
  ).toContain("@luciole-sh/core: no version in the workspace");

  const skewed = join(temp, "skewed");
  await mkdir(join(skewed, "packages"), { recursive: true });
  await cp(
    join(workspace, "packages/core/package.json"),
    join(skewed, "packages/core/package.json"),
  );
  await cp(bare, skewed, { recursive: true });
  await mkdir(join(skewed, "packages/markdown-editor"));
  await Bun.write(
    join(skewed, "packages/markdown-editor/package.json"),
    JSON.stringify({ name: "@luciole-sh/markdown-editor", version: "9.9.9" }),
  );
  expect(
    messageOf(
      await rejectionOf(
        stageStarter({
          workspace: skewed,
          target: join(temp, "skewed-starter"),
          link: "published",
        }),
      ),
    ),
  ).toContain("released in lockstep");
});

test(
  "the starter installs, type-checks, lints, formats and builds",
  async () => {
    // The registry cannot serve packages that are not published. For this test only, the
    // starter's two framework dependencies point at tarballs of this checkout (`bun pm pack`);
    // everything else installs from the registry as it will for a user.
    const core = await pack(join(workspace, "packages/core"), join(temp, "tarballs/core"));
    const editor = await pack(
      join(workspace, "packages/markdown-editor"),
      join(temp, "tarballs/editor"),
    );
    const consumer = join(temp, "build-consumer");
    await mkdir(consumer);
    expect((await run([process.execPath, "add", createTarball], consumer)).code).toBe(0);
    const starter = join(consumer, "app");
    const created = await run(
      [join(consumer, "node_modules/.bin/create-luciole"), "app"],
      consumer,
    );
    expect(created.code, created.output).toBe(0);
    const manifestFile = Bun.file(join(starter, "package.json"));
    const scaffolded = await manifestFile.text();
    const manifest = Starter.parse(JSON.parse(scaffolded));
    manifest.dependencies["@luciole-sh/core"] = `file:${core}`;
    manifest.dependencies["@luciole-sh/markdown-editor"] = `file:${editor}`;
    await Bun.write(manifestFile, JSON.stringify(manifest, null, 2));

    const step = async (script: string) => {
      const result = await run([process.execPath, ...script.split(" ")], starter);
      expect(result.code, `bun ${script}\n${result.output}`).toBe(0);
    };
    await step("install");
    // The format check is of the files as scaffolded, not of the linked manifest above.
    await Bun.write(manifestFile, scaffolded);
    for (const script of ["run check", "run lint", "run format:check", "run build"])
      await step(script);
    expect(await Bun.file(join(starter, ".luciole/server/index.js")).exists()).toBe(true);
  },
  BUILD_TEST_MS * 4,
);
