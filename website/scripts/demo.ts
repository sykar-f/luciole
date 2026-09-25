/**
 * Builds examples/notes as a static site whose Server runs in the browser (docs/WEB.md,
 * `airtty build --web-local`) and copies it to public/demo/notes/, where the landing page
 * embeds it. Generated, not committed: rerun after a change to the framework or to Notes.
 *   bun run demo          # from website/
 */
import { spawnSync } from "node:child_process";
import { cp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const site = join(root, "examples/notes/.airtty/web");
const target = resolve(import.meta.dirname, "../public/demo/notes");

// Node's API, not Bun's: website/ has no Bun types, and Bun runs it the same.
const build = spawnSync(
  "bun",
  ["packages/airtty/src/cli.ts", "build", "--app", "examples/notes", "--web-local"],
  { cwd: root, stdio: ["ignore", "inherit", "inherit"] },
);
if (build.status !== 0) process.exit(build.status ?? 1);

await rm(target, { recursive: true, force: true });
// Source maps weigh twice the rest and only serve DevTools: they stay out of the site.
await cp(site, target, { recursive: true, filter: (path) => !path.endsWith(".map") });
console.log(`demo: ${target}`);
