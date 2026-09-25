/**
 * Stages the application a desktop build embeds:
 *
 *   bun run stage <app directory> [airtty build flags: --runtime, --target, --sign…]
 *
 * Builds it and compiles its two-role binary (`airtty build --compile`) into
 * .stage/bin, then writes .stage/app.json. electrobun.config.ts copies both into the
 * bundle and names the app after it; the host (src/host/index.ts) runs the binary.
 */
import { basename, join, resolve } from "node:path";
import { rm } from "node:fs/promises";
import { STAGE, stagedApp, type StagedApp } from "../src/staged";

const [directory, ...flags] = process.argv.slice(2);
if (!directory) throw new Error("Usage: bun run stage <app directory> [airtty build flags]");
const root = resolve(process.env.INIT_CWD ?? process.cwd(), directory);
// `airtty build --compile` names the binary after the directory, and checks that name.
const name = basename(root);
const stage = resolve(import.meta.dir, "..", STAGE);
await rm(stage, { recursive: true, force: true });
const compiled = Bun.spawnSync(
  ["airtty", "build", "--app", root, "--compile", "--outfile", join(stage, "bin", name), ...flags],
  { stdout: "inherit", stderr: "inherit" },
);
if (compiled.exitCode !== 0) process.exit(compiled.exitCode ?? 1);
const app: StagedApp = { name };
await Bun.write(join(stage, "app.json"), JSON.stringify(stagedApp.parse(app)));
console.log({ staged: name, binary: join(stage, "bin", name) });
