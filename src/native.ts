/**
 * Server packages with native code (a `.node` addon, and the shared libraries it links):
 * they cannot be bundled into one file. The build keeps them external (src/build.ts); an
 * app binary lays them out in `native/node_modules` next to itself (src/compile.ts), as
 * installed, since an addon finds its libraries by paths relative to itself (sharp's
 * `@img/sharp-<platform>` links `../../sharp-libvips-<platform>/lib`). A compiled binary
 * resolves no package at run time, so its Server then runs from `native/server.js`, the
 * binary acting as Bun (BUN_BE_BUN=1), which resolves them like any Bun process.
 *
 * A package is native when it holds a `.node` file, depends on a native loader
 * (node-gyp-build, bindings, prebuild-install, node-pre-gyp), or has platform packages
 * (`os`/`cpu`) holding one among its optionalDependencies, the way sharp ships `@img/*`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { z } from "zod";

const LOADERS = new Set([
  "node-gyp-build",
  "node-gyp-build-optional-packages",
  "bindings",
  "prebuild-install",
  "@mapbox/node-pre-gyp",
  "@neon-rs/load",
]);
const Manifest = z.object({
  name: z.string(),
  version: z.string().optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
  os: z.array(z.string()).optional(),
  cpu: z.array(z.string()).optional(),
  libc: z.array(z.string()).optional(),
});
type Manifest = z.infer<typeof Manifest>;

function manifestOf(directory: string): Manifest | undefined {
  try {
    const parsed = Manifest.safeParse(
      JSON.parse(readFileSync(join(directory, "package.json"), "utf8")),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** `@scope/name/sub` → `@scope/name`; relative, absolute and builtin specifiers → none. */
export function packageName(specifier: string) {
  if (/^(\.|\/|node:|bun:)/.test(specifier) || /^[a-z]+:/.test(specifier)) return undefined;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Where `name` is installed as seen from `from` (a file or directory): node's lookup. */
export function installedPackage(name: string, from: string) {
  for (let directory = from; ; directory = dirname(directory)) {
    const candidate = join(directory, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (directory === dirname(directory)) return undefined;
  }
}

function holdsAddon(directory: string) {
  const stack = [directory];
  while (stack.length) {
    const current = stack.pop() ?? "";
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.name.endsWith(".node")) return true;
    }
  }
  return false;
}
const platformSpecific = (manifest: Manifest) => !!(manifest.os || manifest.cpu);

const native = new Map<string, boolean>();
/** Whether the package installed in `directory` is native (see the module's comment). */
export function isNativeDirectory(directory: string) {
  const known = native.get(directory);
  if (known !== undefined) return known;
  const manifest = manifestOf(directory);
  const found =
    !!manifest &&
    (holdsAddon(directory) ||
      Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }).some((d) =>
        LOADERS.has(d),
      ) ||
      Object.keys(manifest.optionalDependencies ?? {}).some((name) => {
        const installed = installedPackage(name, directory);
        const dependency = installed && manifestOf(installed);
        return !!installed && !!dependency && platformSpecific(dependency) && holdsAddon(installed);
      }));
  native.set(directory, found);
  return found;
}

/** The native package `specifier` names from `importer`, or `undefined`. */
export function nativePackage(specifier: string, importer: string) {
  const name = packageName(specifier);
  if (!name) return undefined;
  const directory = installedPackage(name, dirname(importer));
  return directory && isNativeDirectory(directory) ? { name, directory } : undefined;
}

/** Whether a platform package fits `target` (`bun-linux-x64-musl`…). */
function fits(manifest: Manifest, target: string) {
  const [, os = "", arch = "", libc] = target.split("-");
  const allows = (list: string[] | undefined, value: string) =>
    !list ||
    list.includes(value) ||
    (list.some((v) => v.startsWith("!")) && !list.includes(`!${value}`));
  return (
    allows(manifest.os, os) &&
    allows(manifest.cpu, arch) &&
    (os !== "linux" || allows(manifest.libc, libc === "musl" ? "musl" : "glibc"))
  );
}

export const NATIVE_DIRECTORY = "native";
/** The Server of an app binary with native packages, run by the binary as Bun. */
export const NATIVE_SERVER = "server.js";
const TARGET_FILE = "TARGET";

/**
 * Lays out `packages` and everything they depend on for `target` in
 * `<destination>/node_modules`, with a package.json to resolve from. Platform packages
 * come from `nativeDir` first (installed there for a foreign target), then from where
 * the package itself is installed; other platforms' are left out.
 */
export async function layOutNative(
  packages: ReadonlyMap<string, string>,
  { destination, target, nativeDir }: { destination: string; target: string; nativeDir?: string },
) {
  await rm(destination, { recursive: true, force: true });
  if (!packages.size) return false;
  const placed = new Map<string, { version: string; addon: boolean }>();
  // Places a package and its closure; answers whether an addon came with them.
  const place = async (name: string, source: string, parent: string): Promise<boolean> => {
    const version = manifestOf(source)?.version ?? "";
    const already = placed.get(name);
    if (already?.version === version) return already.addon;
    // Another version already sits at the top: this one goes under its dependent.
    const into =
      already === undefined
        ? join(destination, "node_modules", name)
        : join(parent, "node_modules", name);
    const entry = { version, addon: holdsAddon(source) };
    if (already === undefined) placed.set(name, entry);
    await mkdir(dirname(into), { recursive: true });
    await cp(source, into, {
      recursive: true,
      dereference: true,
      filter: (path) => !relative(source, path).split("/").includes("node_modules"),
    });
    const manifest = manifestOf(source);
    const dependencies = Object.keys(manifest?.dependencies ?? {});
    const optional = Object.keys(manifest?.optionalDependencies ?? {});
    for (const dependency of [...dependencies, ...optional]) {
      const found =
        (nativeDir && installedPackage(dependency, nativeDir)) ||
        installedPackage(dependency, source);
      const dependencyManifest = found && manifestOf(found);
      if (!found || !dependencyManifest) {
        if (optional.includes(dependency)) continue;
        throw new Error(`${name} needs ${dependency}, which is not installed`);
      }
      if (platformSpecific(dependencyManifest) && !fits(dependencyManifest, target)) continue;
      if (await place(dependency, found, into)) entry.addon = true;
    }
    return entry.addon;
  };
  // Each native package must bring an addon for the target, itself or by a dependency.
  for (const [name, source] of packages)
    if (!(await place(name, source, destination)))
      throw new Error(
        `${name} has no native code for ${target} here: install it for that target ` +
          `(bun add ${name} --os=… --cpu=…) in a directory passed as --native-dir`,
      );
  await writeFile(join(destination, "package.json"), '{ "private": true }\n');
  await writeFile(join(destination, TARGET_FILE), `${target}\n`);
  return true;
}

/** The target a laid-out `native/` was made for, if any. */
export function nativeTarget(directory: string) {
  const file = join(directory, TARGET_FILE);
  return existsSync(file) && statSync(file).isFile()
    ? readFileSync(file, "utf8").trim()
    : undefined;
}
