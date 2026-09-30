import { cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

// dist/: ESM JavaScript and declarations, one file per module, with the TypeScript 7
// compiler (a bare `tsc` from node_modules/.bin may be the TypeScript 6 one, see
// scripts/check.ts at the repository's root).
const root = join(import.meta.dir, "..");
// Another directory as the first argument: the package's test builds into a temporary one.
const out = process.argv[2] ?? join(root, "dist");
const tsc = join(dirname(Bun.resolveSync("typescript/package.json", root)), "bin/tsc");

rmSync(out, { recursive: true, force: true });
const child = Bun.spawnSync(
  [process.execPath, tsc, "-p", join(root, "tsconfig.build.json"), "--outDir", out],
  {
    stdout: "inherit",
    stderr: "inherit",
  },
);
if (child.exitCode !== 0) process.exit(child.exitCode ?? 1);
// The MIT notice of the code taken from xyflow travels with its compiled form.
cpSync(join(root, "src/vendor/xyflow/LICENSE"), join(out, "vendor/xyflow/LICENSE"));
console.log(`built ${out}`);
