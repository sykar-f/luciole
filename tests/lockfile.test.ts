import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { governingLock } from "../packages/luciole/src/lockfile";

const work = await mkdtemp(join(tmpdir(), "luciole-lockfile-"));
afterAll(() => rm(work, { recursive: true, force: true }));

test("the framework of this checkout is governed by its root lock", () => {
  expect(governingLock(resolve("packages/luciole/src"))).toBe(resolve("bun.lock"));
});

test("a workspace member and a package installed below an app share the enclosing lock", async () => {
  const root = join(work, "workspace");
  await mkdir(join(root, ".git"), { recursive: true });
  await mkdir(join(root, "examples/notes/app"), { recursive: true });
  await mkdir(join(root, "node_modules/luciole/src"), { recursive: true });
  await Bun.write(join(root, "bun.lock"), "{}");
  expect(governingLock(join(root, "examples/notes"))).toBe(join(root, "bun.lock"));
  expect(governingLock(join(root, "node_modules/luciole/src"))).toBe(join(root, "bun.lock"));
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
