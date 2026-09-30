/**
 * What a sandboxed child needs to read to run at all (src/sandbox/profile.ts): Bun and
 * the libraries it links, luciole's sources, the node_modules its runtime resolves from.
 * Found once per host process; nothing of the user's files.
 */
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { ABI_PACKAGES } from "../abi";
import { lucioleSources } from "../sources";
import { detectMechanism, type Availability } from "./mechanism";
import type { SandboxRuntime } from "./profile";

/**
 * luciole's `src/` and the directory holding its package.json, even when this module runs
 * bundled into an application (src/sources.ts).
 */
const SOURCES = lucioleSources(dirname(import.meta.dir));
const ROOT = dirname(SOURCES);
const HERE = join(SOURCES, "sandbox");
/**
 * The sandboxed side, built (`buildChild`) from src/sandbox/child.ts inside luciole's tree,
 * where its external packages resolve from node_modules.
 */
export const CHILD_ENTRY = join(HERE, ".luciole", "child.js");
// Files Bun reads next to the sources it runs: module type, path aliases, its settings.
const MANIFESTS = ["package.json", "tsconfig.json", "tsconfig.base.json", "bunfig.toml"];

let availability: Availability | undefined;
/** What confines a sandboxed Client here (src/sandbox/mechanism.ts), found once. */
export const sandboxAvailability = (env: NodeJS.ProcessEnv = process.env) =>
  (availability ??= detectMechanism(ROOT, env));
/** Whether this machine can run the `sandbox` mode at all. */
export const sandboxSupported = () => sandboxAvailability().mechanism !== undefined;

/** The `node_modules` directory a package resolves from, seen from luciole's sources. */
function nodeModulesOf(name: string) {
  const file = realpathSync(Bun.resolveSync(`${name}/package.json`, SOURCES));
  const at = file.lastIndexOf(`${sep}node_modules${sep}`);
  if (at < 0) throw new Error(`${name} is not installed in a node_modules directory`);
  return file.slice(0, at + `${sep}node_modules`.length);
}

/**
 * Non-system dylibs `bun` links on macOS (Nix installs ICU next to it), by their
 * directories. On Linux its system libraries are under /usr and /lib, read anyway.
 */
function libraries(bun: string) {
  if (process.platform !== "darwin") return [];
  const listed = spawnSync("otool", ["-L", bun], { encoding: "utf8" }).stdout ?? "";
  return [
    ...new Set(
      listed
        .split("\n")
        .slice(1)
        .map((line) => line.trim().split(" ")[0] ?? "")
        .filter((p) => p.startsWith("/") && !p.startsWith("/usr/lib/") && !p.startsWith("/System/"))
        .map((p) => dirname(dirname(p))),
    ),
  ];
}

// As the Client build (src/build.ts): native or context-carrying packages stay external,
// and TanStack's client build is used, Bun's "bun" condition would pick its server one.
const EXTERNAL = [
  "react",
  "react-dom",
  "react-server-dom-webpack",
  "@opentui/core",
  "@opentui/react",
  "react-reconciler",
];
/** Builds CHILD_ENTRY: run as a Client, from sources Bun would resolve as a server. */
export async function buildChild() {
  const result = await Bun.build({
    entrypoints: [join(HERE, "child.ts")],
    outdir: dirname(CHILD_ENTRY),
    naming: basename(CHILD_ENTRY),
    target: "bun",
    external: EXTERNAL,
    jsx: { runtime: "automatic", development: false },
    plugins: [
      {
        name: "luciole-sandbox-child",
        setup(b) {
          b.onResolve({ filter: /^@tanstack\/router-core\/isServer$/ }, () => ({
            path: join(
              dirname(Bun.resolveSync("@tanstack/router-core/isServer", SOURCES)),
              "client.js",
            ),
          }));
        },
      },
    ],
  });
  if (!result.success)
    throw new Error(`The sandbox child did not build: ${result.logs.map(String).join("\n")}`);
  return CHILD_ENTRY;
}

let found: SandboxRuntime | undefined;
export function sandboxRuntime(): SandboxRuntime {
  if (found) return found;
  const bun = realpathSync(process.execPath);
  found = {
    bun,
    // Its own prefix too: a Nix or Homebrew Bun keeps its files beside the binary.
    libraries: [dirname(dirname(bun)), ...libraries(bun)],
    code: [
      SOURCES,
      ...new Set(
        [...Object.keys(ABI_PACKAGES), "react-dom", "react-reconciler"].map(nodeModulesOf),
      ),
      ...MANIFESTS.map((f) => join(ROOT, f)).filter((f) => existsSync(f)),
    ],
  };
  return found;
}
