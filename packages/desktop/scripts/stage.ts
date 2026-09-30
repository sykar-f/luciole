/**
 * Stages the application a desktop build embeds:
 *
 *   bun run stage <app directory> [luciole build flags: --runtime, --target, --sign…]
 *
 * Builds it and compiles its two-role binary (`luciole build --compile`) into
 * .stage/bin, then stages what its build says of it (`.luciole/metadata.json`, the icon).
 * electrobun.config.ts names and decorates the bundle with them; the host
 * (src/host/index.ts) runs the binary under the window's title.
 */
import { copyFile, mkdir, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { APP_METADATA } from "luciole/metadata";
import { ICON_PNG, ICONSET, METADATA, STAGE, readMetadata } from "../src/staged";

// Sizes of a macOS iconset, in points: each at 1x and 2x, up to 1024 pixels.
const ICONSET_POINTS = ["16", "32", "128", "256", "512"];

/** A macOS iconset from one PNG, with the system's own resampler (`iconutil` reads it). */
async function writeIconset(png: string, directory: string) {
  await mkdir(directory, { recursive: true });
  for (const points of ICONSET_POINTS)
    for (const scale of [1, 2]) {
      const pixels = String(Number(points) * scale);
      const file = `icon_${points}x${points}${scale === 2 ? "@2x" : ""}.png`;
      const resized = Bun.spawnSync(
        ["sips", "-z", pixels, pixels, png, "--out", join(directory, file)],
        { stdout: "ignore", stderr: "inherit" },
      );
      if (resized.exitCode !== 0) throw new Error(`sips could not write ${file}`);
    }
}

const [directory, ...flags] = process.argv.slice(2);
if (!directory) throw new Error("Usage: bun run stage <app directory> [luciole build flags]");
const root = resolve(process.env.INIT_CWD ?? process.cwd(), directory);
// `luciole build --compile` names the binary after the directory, and checks that name.
const name = basename(root);
const stage = resolve(import.meta.dir, "..", STAGE);
await rm(stage, { recursive: true, force: true });
const compiled = Bun.spawnSync(
  // --portable: the bundle is for other people's machines; a runtime that links anything
  // but the system's libraries fails here rather than on their Mac.
  [
    "luciole",
    "build",
    "--app",
    root,
    "--compile",
    "--portable",
    "--outfile",
    join(stage, "bin", name),
    ...flags,
  ],
  { stdout: "inherit", stderr: "inherit" },
);
if (compiled.exitCode !== 0) process.exit(compiled.exitCode ?? 1);

const output = join(root, ".luciole");
const metadata = readMetadata(await Bun.file(join(output, APP_METADATA)).text());
await Bun.write(join(stage, METADATA), JSON.stringify(metadata, null, 2));
if (metadata.icon) {
  await copyFile(join(output, metadata.icon), join(stage, ICON_PNG));
  if (process.platform === "darwin")
    await writeIconset(join(stage, ICON_PNG), join(stage, ICONSET));
}
console.log({ staged: metadata.displayName, binary: join(stage, "bin", name) });
