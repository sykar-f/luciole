import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";

const core = resolve(import.meta.dir, "..");
const output = join(core, "dts");
// A failed emit must never leave declarations from an earlier pack in the next one.
rmSync(output, { recursive: true, force: true });
if (!process.argv.includes("--clean")) {
  const tsc = Bun.resolveSync("@typescript/typescript6/bin/tsc6", core);
  const child = Bun.spawn([process.execPath, tsc, "-p", join(core, "tsconfig.dts.json")], {
    cwd: core,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) {
    rmSync(output, { recursive: true, force: true });
    process.exit(code);
  }
  // tsc does not copy ambient inputs. Carry Flight's overloads and marker modules,
  // and reference them from each entry so consumers need no ambient setup of their own.
  const ambient = join(output, "packages/core/types.d.ts");
  const markers = join(output, "packages/core/src/markers.d.ts");
  mkdirSync(dirname(markers), { recursive: true });
  copyFileSync(join(core, "types.d.ts"), ambient);
  copyFileSync(join(core, "src/markers.d.ts"), markers);
  const manifest = z
    .object({ exports: z.record(z.string(), z.unknown()) })
    .parse(await Bun.file(join(core, "package.json")).json());
  for (const entry of Object.values(manifest.exports)) {
    if (!entry || typeof entry !== "object" || !("types" in entry)) continue;
    const target = join(core, String(entry.types));
    const references = [ambient, markers]
      .map((file) => `/// <reference path="${relative(dirname(target), file)}" />\n`)
      .join("");
    writeFileSync(target, references + readFileSync(target, "utf8"));
  }
}
