import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const alias = join(import.meta.dir, "../packages/luciole.sh/bin.ts");
const core = join(import.meta.dir, "../packages/core/src/cli.ts");

/** Runs a bin with an empty home, so that `list` sees no installed app. */
async function run(bin: string, args: string[]) {
  const home = mkdtempSync(join(tmpdir(), "luciole-alias-"));
  const child = Bun.spawn([process.execPath, bin, ...args], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

test("the alias passes core's output and a zero exit code through", async () => {
  const direct = await run(core, ["list"]);
  const viaAlias = await run(alias, ["list"]);
  expect(direct.code).toBe(0);
  expect(viaAlias).toEqual(direct);
  expect(viaAlias.stdout).toContain("No app installed.");
});

test("the alias passes core's usage error and its non-zero exit code through", async () => {
  const direct = await run(core, ["--version"]);
  const viaAlias = await run(alias, ["--version"]);
  expect(direct.code).not.toBe(0);
  expect(viaAlias).toEqual(direct);
  expect(viaAlias.stderr).toContain("Usage: luciole");
});

test("the alias runs core in its own process: nothing is spawned to forward signals to", async () => {
  const source = await Bun.file(alias).text();
  expect(source).not.toMatch(/spawn|child_process|Bun\.\$|execa/);
  expect(source).toContain("./src/cli.ts");
});
