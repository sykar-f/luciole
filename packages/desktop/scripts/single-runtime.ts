/**
 * Electrobun's `postBuild` hook (electrobun.config.ts): one Bun in the bundle instead of
 * two. The app binary (`bun build --compile`) carries a whole Bun; Electrobun ships
 * another to run the host. Here the app binary runs the host too, as Bun
 * (`BUN_BE_BUN=1`), and Electrobun's copy is dropped: about 60 MB less.
 *
 *   Contents/MacOS/bun      a script: `BUN_BE_BUN=1 exec ./<app> "$@"`, what Electrobun's
 *                           launcher starts with the host's main.js
 *   Contents/MacOS/<app>    the app binary, beside Electrobun's libraries: the host loads
 *                           them next to the running executable
 *   Resources/app/airtty/bin/<app>   a link to it, where the host starts the app
 *
 * The host starts the app without `BUN_BE_BUN` (src/host/session.ts). Runs before
 * Electrobun signs the bundle, so the signature covers this layout. macOS only for now:
 * other platforms keep both runtimes.
 *
 * Run by Hutch (Cottontail): Node's APIs only.
 */
import {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { BUNDLED, METADATA, readMetadata } from "../src/staged";

const { ELECTROBUN_OS: os, ELECTROBUN_BUILD_DIR: buildDir } = process.env;
if (!buildDir) throw new Error("single-runtime: run as Electrobun's postBuild hook");
if (os !== "macos") {
  console.log(`single-runtime: ${os} keeps Electrobun's Bun`);
  process.exit(0);
}

const bundles = readdirSync(buildDir).filter((entry) => entry.endsWith(".app"));
if (bundles.length !== 1)
  throw new Error(`single-runtime: expected one .app in ${buildDir}, found ${bundles.length}`);
const contents = join(buildDir, String(bundles[0]), "Contents");
const macos = join(contents, "MacOS");
const bundled = join(contents, "Resources", "app", BUNDLED);
const { name } = readMetadata(readFileSync(join(bundled, METADATA), "utf8"));
const linked = join(bundled, "bin", name);
const binary = join(macos, name);
const runtime = join(macos, "bun");
if (!existsSync(runtime) || !existsSync(linked))
  throw new Error(`single-runtime: ${contents} lacks MacOS/bun or the app binary`);

renameSync(linked, binary);
symlinkSync(relative(join(bundled, "bin"), binary), linked);
// The binary finds native packages next to itself (src/launcher/binary.ts).
const native = join(bundled, "bin", "native");
if (existsSync(native)) symlinkSync(relative(macos, native), join(macos, "native"));
rmSync(runtime);
writeFileSync(
  runtime,
  `#!/bin/sh\n# The app binary runs the host as Bun (packages/desktop/scripts/single-runtime.ts).\nBUN_BE_BUN=1 exec "$(dirname "$0")/${name}" "$@"\n`,
);
const EXECUTABLE = 0o755;
chmodSync(runtime, EXECUTABLE);
console.log(`single-runtime: ${name} runs the host; Electrobun's Bun removed`);
