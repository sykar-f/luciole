import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkCoreTypes } from "../scripts/pack-check";

import { copyPackWorkspace } from "./pack-workspace";

const temp = mkdtempSync(join(tmpdir(), "packed-declarations-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

async function run(command: string[], cwd: string, env = process.env): Promise<string> {
  const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${command.join(" ")}: ${out}${err}`);
  return out;
}

test("packed core resolves every entry to declarations in a strict consumer", async () => {
  const tarball = join(temp, "core.tgz");
  const revision = (await run(["git", "rev-parse", "HEAD"], resolve("."))).trim();
  // Other tests pack core too. Give prepack/postpack their own output directory.
  const workspace = await copyPackWorkspace(join(temp, "workspace"));
  await run(
    [process.execPath, "pm", "pack", "--filename", tarball, "--quiet"],
    join(workspace, "packages/core"),
    { ...process.env, GITHUB_SHA: revision },
  );
  expect(
    await Bun.file(join(workspace, "packages/core/dts/packages/core/src/server.d.ts")).exists(),
  ).toBe(false);
  const consumer = join(temp, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@luciole-sh/core": `file:${tarball}`,
        react: "19.3.0",
        "react-dom": "19.3.0",
        "@types/bun": "1.4.2",
        "@types/react": "19.3.0",
        "@types/react-dom": "19.3.0",
      },
    }),
  );
  await run([process.execPath, "install"], consumer);
  await run(
    [
      process.execPath,
      "-e",
      `
    const manifest = await Bun.file("node_modules/@luciole-sh/core/package.json").json();
    for (const [entry, targets] of Object.entries(manifest.exports)) {
      if (typeof targets !== "object") continue;
      const resolved = Bun.resolveSync("@luciole-sh/core/" + entry.slice(2), process.cwd());
      if (!resolved.endsWith(targets.bun.slice(1))) throw new Error(resolved);
    }
  `,
    ],
    consumer,
  );
  // Exercise the same nested route tree and imports as the source consumer fixture.
  cpSync("tests/fixtures/strict-consumer/app", join(consumer, "app"), { recursive: true });
  cpSync("tests/fixtures/strict-consumer/index.ts", join(consumer, "index.ts"));
  // If TypeScript follows runtime targets, this implementation error must fail the check.
  writeFileSync(
    join(consumer, "node_modules/@luciole-sh/core/src/server.ts"),
    "const mustNotBeChecked: string = 42;\nexport { mustNotBeChecked };\n",
  );
  const resolved: string[] = [];
  expect(await checkCoreTypes(consumer, (line) => resolved.push(line))).toEqual([]);
  expect(resolved).toHaveLength(13);
  expect(resolved.every((line) => line.endsWith(".d.ts"))).toBe(true);
  // macOS exposes temporary directories through /var and /private/var. Exercise
  // an alias on every platform: TypeScript reports the physical declaration path.
  const alias = join(temp, "consumer-alias");
  symlinkSync(consumer, alias, "dir");
  const aliased: string[] = [];
  expect(await checkCoreTypes(alias, (line) => aliased.push(line))).toEqual([]);
  expect(aliased).toEqual(resolved);
  const flight = await Bun.file(
    join(consumer, "node_modules/@luciole-sh/core/dts/packages/core/types.d.ts"),
  ).text();
  expect(flight.match(/export function decodeReply\(/g)).toHaveLength(4);
}, 120_000);
