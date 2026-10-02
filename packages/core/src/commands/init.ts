import { basename, join, resolve, sep } from "node:path";
import { cp, mkdir, readdir } from "node:fs/promises";
import { z } from "zod";
import { readJsonFile, readPackageJson } from "../package-json";
import { canGreet, mascotArt } from "../mascot";
import { frameworkRoot, workspaceRoot, type Command } from "./command";
/** The formatter options a starter's generated JSON files follow. */
const FormatterConfig = z.object({
  printWidth: z.number().int().positive(),
  sortImports: z.boolean(),
  sortPackageJson: z.boolean(),
});
/** A workspace package's manifest: the fields vendoring rewrites, the rest passes through. */
const VendoredManifest = z.looseObject({
  scripts: z.unknown().optional(),
  devDependencies: z.unknown().optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
});
/** The framework package that a starter depends on, and the version it asks for when installed. */
const FRAMEWORK_NAME = "@luciole-sh/core";
/** Where the workspace packages a starter needs are copied, in workspace mode. */
const VENDOR_DIR = "vendor";

/**
 * Whether the framework runs from an installed package or from the workspace.
 * Installed: the framework root lies inside a `node_modules` directory, which is where a package
 * manager puts a dependency. Anywhere else (the clone `packages/core` is checked out in) it is
 * the workspace, whose packages are linked from disk.
 */
export function isInstalled(root: string): boolean {
  return root.split(sep).includes("node_modules");
}

/** The workspace packages by name: their directory and version (`packages/*`). */
async function workspacePackages(workspace: string) {
  const found = new Map<string, { directory: string; version?: string }>();
  const entries = await readdir(join(workspace, "packages")).catch((): string[] => []);
  for (const entry of entries) {
    const directory = join(workspace, "packages", entry);
    const manifest = await readPackageJson(join(directory, "package.json")).catch(() => undefined);
    if (manifest?.name) found.set(manifest.name, { directory, version: manifest.version });
  }
  return found;
}

/**
 * Writes a starter into `target`. `framework` is the framework package's root, `workspace` the
 * tree holding the Notes example and the tooling configuration the starter copies.
 */
export async function createStarter(options: {
  target: string;
  framework: string;
  workspace: string;
}): Promise<void> {
  const { target, framework: frameworkRoot, workspace: workspaceRoot } = options;
  if ((await readdir(target).catch((): string[] => [])).length)
    throw new Error("Target already contains a project");
  await mkdir(target, { recursive: true });
  await cp(join(workspaceRoot, "examples/notes"), target, {
    recursive: true,
    filter: (p) =>
      !p.includes(".luciole") &&
      !p.endsWith(".sqlite") &&
      !p.endsWith(".sqlite-wal") &&
      !p.endsWith(".sqlite-shm"),
  });
  const frameworkPackage = await readPackageJson(join(frameworkRoot, "package.json"));
  const notesPackage = await readPackageJson(join(workspaceRoot, "examples/notes/package.json"));
  // A starter is no workspace member: `catalog:` becomes the version the workspace pins.
  const catalog =
    (await readPackageJson(join(workspaceRoot, "package.json"))).workspaces?.catalog ?? {};
  const installed = isInstalled(frameworkRoot);
  const packages = await workspacePackages(workspaceRoot);
  const frameworkVersion = frameworkPackage.version;
  if (installed && !frameworkVersion) throw new Error(`${frameworkRoot}: no version`);
  // The framework, and the workspace packages the starter names `workspace:*`:
  // installed, a published range of the version at hand; in the workspace, a link `bun install`
  // resolves. The framework has no `catalog:` of its own, so `file:` reaches it as it is. Any
  // other package does (a `file:` dependency does not resolve `catalog:` inside it), so it is
  // copied into the starter with its catalog pinned.
  let vendored = false;
  const link = async (name: string): Promise<string> => {
    const workspacePackage = packages.get(name);
    if (installed) {
      // The packages are published together, so the framework's version stands in for one
      // that this tree does not hold.
      if (name === FRAMEWORK_NAME) return `^${frameworkVersion}`;
      return `^${workspacePackage?.version ?? frameworkVersion}`;
    }
    if (name === FRAMEWORK_NAME) return `file:${frameworkRoot}`;
    if (!workspacePackage) throw new Error(`${name}: no such package in the workspace`);
    const copy = join(target, VENDOR_DIR, name.replace(/^@[^/]+\//, ""));
    await cp(workspacePackage.directory, copy, {
      recursive: true,
      filter: (p) => !p.includes("node_modules") && !p.includes("/test"),
    });
    const manifest = await readJsonFile(join(copy, "package.json"), VendoredManifest);
    // No build on install (`prepack`), no development tooling: `src` is what the `bun` export reads.
    const { scripts: _scripts, devDependencies: _devDependencies, ...kept } = manifest;
    await Bun.write(
      join(copy, "package.json"),
      // Nothing is built in the copy, so `dist/*` (types and default) points at `src` too.
      JSON.stringify({ ...kept, dependencies: pinned(manifest.dependencies) }, null, 2).replace(
        /\.\/dist\/index\.(d\.ts|js)/g,
        "./src/index.ts",
      ),
    );
    vendored = true;
    return `file:./${VENDOR_DIR}/${basename(copy)}`;
  };
  const pinned = (dependencies: Record<string, string> = {}) =>
    Object.fromEntries(
      Object.entries(dependencies).map(([name, range]) => {
        if (range !== "catalog:") return [name, range];
        const version = catalog[name];
        if (!version) throw new Error(`${name}: catalog: without a version in the workspace`);
        return [name, version];
      }),
    );
  const resolved: Record<string, string> = {};
  for (const [name, range] of Object.entries(pinned(notesPackage.dependencies)))
    resolved[name] = range.startsWith("workspace:") ? await link(name) : range;
  resolved[FRAMEWORK_NAME] = await link(FRAMEWORK_NAME);
  await Bun.write(
    join(target, "package.json"),
    JSON.stringify(
      {
        private: true,
        type: "module",
        packageManager: frameworkPackage.packageManager,
        dependencies: resolved,
        devDependencies: pinned(frameworkPackage.devDependencies),
        overrides: frameworkPackage.overrides,
        scripts: {
          dev: "luciole dev --app .",
          build: "luciole build --app .",
          // Not a bare `tsc`: `.bin/tsc` is TypeScript 6's, from `@typescript/old`.
          check: "bun node_modules/typescript/bin/tsc --noEmit",
          lint: "oxlint --deny-warnings .",
          "lint:fix": "oxlint --fix .",
          format: "oxfmt --write .",
          "format:check": "oxfmt --check .",
          verify: "bun run check && bun run lint && bun run format:check && bun run build",
        },
      },
      null,
      2,
    ),
  );
  await Bun.write(
    join(target, "tsconfig.json"),
    JSON.stringify(
      {
        extends: "@luciole-sh/core/tsconfig",
        include: ["app", "components", "actions", "server"],
        exclude: ["node_modules", ".luciole"],
      },
      null,
      2,
    ) + "\n",
  );
  for (const file of [".oxlintrc.json", ".oxfmtrc.json", ".vscode", ".gitignore", ".bun-version"]) {
    await cp(join(workspaceRoot, file), join(target, file), { recursive: true });
  }
  const { format } = await import("oxfmt");
  const { printWidth, sortImports, sortPackageJson } = await readJsonFile(
    join(workspaceRoot, ".oxfmtrc.json"),
    FormatterConfig,
  );
  if (vendored) {
    // The vendored copies are neither the starter's code nor to be linted or formatted.
    for (const name of [".oxlintrc.json", ".oxfmtrc.json"]) {
      const file = join(target, name);
      const config = await readJsonFile(
        file,
        z.looseObject({ ignorePatterns: z.array(z.string()) }),
      );
      config.ignorePatterns.push(`${VENDOR_DIR}/**`);
      await Bun.write(file, JSON.stringify(config, null, 2) + "\n");
    }
  }
  for (const name of ["package.json", "tsconfig.json", ".oxlintrc.json", ".oxfmtrc.json"]) {
    const file = Bun.file(join(target, name));
    const result = await format(name, await file.text(), {
      printWidth,
      sortImports,
      sortPackageJson,
    });
    if (result.errors.length) throw new Error(`Cannot format generated ${name}`);
    await Bun.write(file, result.code);
  }
  console.log(`Starter created: ${target}\nRun bun install in the starter, then bun run dev.`);
  // The useful lines first; the picture is a greeting, for a person at a colour terminal.
  if (canGreet(process.stdout, process.env)) console.log(`\n${mascotArt()}`);
}

export const init: Command = {
  usage: "init <dir>",
  async run({ args }) {
    await createStarter({
      target: resolve(args[1] ?? "my-luciole-app"),
      framework: frameworkRoot,
      workspace: workspaceRoot,
    });
  },
};
