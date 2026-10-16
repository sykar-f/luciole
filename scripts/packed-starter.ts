/**
 * The published starter path on the Bun running this script (CI also runs the minimum):
 * pack this tree, create outside it, install, verify, test, build, open the first page and quit.
 * Run with `bun scripts/packed-starter.ts`; no package is fetched from a luciole release.
 */
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { drive } from "./pty/driver";

const root = resolve(import.meta.dir, "..");
const temp = await mkdtemp(join(tmpdir(), "luciole-packed-starter-"));
const revision = Bun.spawn(["git", "rev-parse", "HEAD"], {
  cwd: root,
  stdout: "pipe",
  stderr: "inherit",
});
const sha = (await new Response(revision.stdout).text()).trim();
assert.equal(await revision.exited, 0, "Cannot identify the checkout being packed");
// Package scripts and their /usr/bin/env bun shebangs must use the same Bun as this script.
const env = {
  ...process.env,
  PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
  // Packed docs pin source links; the isolated copy deliberately has no .git.
  GITHUB_SHA: sha,
};
const Manifest = z.looseObject({
  dependencies: z.record(z.string(), z.string()),
  devDependencies: z.record(z.string(), z.string()),
});
async function run(args: string[], cwd: string) {
  console.log(`packed-starter (${Bun.version}): bun ${args.join(" ")}`);
  const child = Bun.spawn([process.execPath, ...args], {
    cwd,
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  assert.equal(await child.exited, 0, `bun ${args.join(" ")} failed`);
}
try {
  // prepack/postpack generate files. Isolate them just as tests/create.test.ts does,
  // so a concurrent test/build cannot copy a live lock or remove another pack's output.
  const workspace = join(temp, "workspace");
  await cp(root, workspace, {
    recursive: true,
    filter: (path) =>
      ![".git", "node_modules", "dts", "target", "dist", ".astro"].includes(basename(path)) &&
      !basename(path).startsWith(".luciole") &&
      !path.includes("/docs/missions"),
  });
  await symlink(join(root, "node_modules"), join(workspace, "node_modules"), "dir");
  const tarballs = new Map<string, string>();
  for (const name of ["core", "flow-graph", "markdown-editor", "create", "luciole.sh"]) {
    const destination = join(temp, "tarballs", name);
    await mkdir(destination, { recursive: true });
    await run(
      ["pm", "pack", "--destination", destination, "--quiet"],
      join(workspace, "packages", name),
    );
    const files = await readdir(destination);
    assert.equal(files.length, 1);
    tarballs.set(name, join(destination, z.string().parse(files[0])));
  }
  const consumer = join(temp, "consumer");
  await mkdir(consumer);
  await run(["add", z.string().parse(tarballs.get("create"))], consumer);
  await run([join(consumer, "node_modules/.bin/create-luciole"), "app"], consumer);
  const app = join(consumer, "app");
  assert.equal(
    await Bun.file(join(app, ".bun-version")).text(),
    await Bun.file(join(root, ".bun-version")).text(),
  );
  const file = Bun.file(join(app, "package.json"));
  const scaffolded = await file.text();
  const manifest = Manifest.parse(JSON.parse(scaffolded));
  const catalog = z
    .object({ workspaces: z.object({ catalog: z.record(z.string(), z.string()) }) })
    .parse(await Bun.file(join(root, "package.json")).json()).workspaces.catalog;
  assert.equal(manifest.devDependencies["@types/bun"], catalog["@types/bun"]);
  for (const name of ["core", "markdown-editor"])
    manifest.dependencies[`@luciole-sh/${name}`] = `file:${tarballs.get(name)}`;
  await Bun.write(file, JSON.stringify(manifest, null, 2));
  await run(["install"], app);
  // Verify the actual scaffold's formatting; the installed dependencies still use our tarballs.
  await Bun.write(file, scaffolded);
  await run(["run", "verify"], app);
  await run(["run", "test"], app);
  await run(["run", "build"], app);
  {
    await using terminal = await drive({
      command: [process.execPath, join(app, "node_modules/.bin/luciole"), "dev"],
      cwd: app,
      cols: 140,
      rows: 40,
      env: { ...env, XDG_STATE_HOME: join(temp, "state"), NOTES_DB: join(temp, "notes.sqlite") },
    });
    await terminal.waitFor("Welcome to Notes");
    await terminal.quit();
  }
  console.log(
    `Packed starter passed on Bun ${Bun.version}, including dev first page and clean quit.`,
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
