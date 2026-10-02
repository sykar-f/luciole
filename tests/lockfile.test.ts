import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { governingLock, isLinkedSource, linkedPackages } from "../packages/core/src/lockfile";

const work = await mkdtemp(join(tmpdir(), "luciole-lockfile-"));
afterAll(() => rm(work, { recursive: true, force: true }));

test("the framework of this checkout is governed by its root lock", () => {
  expect(governingLock(resolve("packages/core/src"))).toBe(resolve("bun.lock"));
});

test("a workspace member and a package installed below an app share the enclosing lock", async () => {
  const root = join(work, "workspace");
  await mkdir(join(root, ".git"), { recursive: true });
  await mkdir(join(root, "examples/notes/app"), { recursive: true });
  await mkdir(join(root, "node_modules/@luciole-sh/core/src"), { recursive: true });
  await Bun.write(join(root, "bun.lock"), "{}");
  expect(governingLock(join(root, "examples/notes"))).toBe(join(root, "bun.lock"));
  expect(governingLock(join(root, "node_modules/@luciole-sh/core/src"))).toBe(
    join(root, "bun.lock"),
  );
});

test("the nearest lock wins, and none is taken from above the git checkout", async () => {
  const outside = join(work, "outside");
  const app = join(outside, "repository/apps/notes");
  await mkdir(join(outside, "repository/.git"), { recursive: true });
  await mkdir(app, { recursive: true });
  await Bun.write(join(outside, "bun.lock"), "{}");
  expect(governingLock(app)).toBeUndefined();
  await Bun.write(join(app, "bun.lock"), "{}");
  expect(governingLock(app)).toBe(join(app, "bun.lock"));
});

test("the workspace packages an app links are found; installed ones and luciole are not", async () => {
  const root = await mkdtemp(join(tmpdir(), "luciole-linked-"));
  try {
    const app = join(root, "apps/notes");
    await mkdir(join(app, "node_modules"), { recursive: true });
    await mkdir(join(root, "packages/markdown-editor"), { recursive: true });
    await mkdir(join(root, "packages/core"), { recursive: true });
    await mkdir(join(app, "node_modules/installed"), { recursive: true });
    await Bun.write(
      join(app, "package.json"),
      JSON.stringify({
        dependencies: {
          "@luciole-sh/markdown-editor": "workspace:*",
          "@luciole-sh/core": "workspace:*",
          installed: "1.0.0",
        },
      }),
    );
    await mkdir(join(app, "node_modules/@luciole-sh"), { recursive: true });
    await symlink(
      join(root, "packages/markdown-editor"),
      join(app, "node_modules/@luciole-sh/markdown-editor"),
    );
    await symlink(join(root, "packages/core"), join(app, "node_modules/@luciole-sh/core"));
    expect(linkedPackages(app)).toEqual([await realpath(join(root, "packages/markdown-editor"))]);
    expect(isLinkedSource("src/index.ts")).toBe(true);
    expect(isLinkedSource("node_modules/x/index.ts")).toBe(false);
    expect(isLinkedSource("dist/index.js")).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Notes links its editor", () => {
  expect(linkedPackages(resolve("examples/notes")).map((dir) => basename(dir))).toEqual([
    "markdown-editor",
  ]);
});
