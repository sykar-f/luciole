/**
 * Stages the template this package ships, `template/`, from examples/notes:
 *
 *   bun scripts/stage.ts                        (also `prepack`'s job: `bun pm pack`, `npm pack`)
 *   bun scripts/stage.ts --workspace <dir>      a starter that links this checkout, for `luciole init`
 *
 * The first resolves every `catalog:` and `workspace:` range to the published versions and inlines
 * the root configuration, so that the consumer's run reads nothing from a repository.
 */
import { rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PACKED_GITIGNORE } from "../src/scaffold";
import { stageStarter } from "./starter";

const workspace = resolve(import.meta.dir, "../../..");
const [flag, directory, ...extra] = process.argv.slice(2);

if (flag === "--workspace" && directory && !extra.length) {
  const target = resolve(directory);
  await stageStarter({ workspace, target, link: "workspace" });
  console.log(`Starter created: ${target}\nRun bun install in the starter, then bun run dev.`);
} else if (flag === undefined) {
  const template = join(import.meta.dir, "../template");
  await rm(template, { recursive: true, force: true });
  await stageStarter({ workspace, target: template, link: "published" });
  await rename(join(template, ".gitignore"), join(template, PACKED_GITIGNORE));
  console.log(`staged ${template}`);
} else {
  console.error("Usage: bun scripts/stage.ts [--workspace <dir>]");
  process.exit(1);
}
