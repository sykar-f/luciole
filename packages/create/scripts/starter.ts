import { basename, join, relative, sep } from "node:path";
import { cp, mkdir, readdir } from "node:fs/promises";
import { format } from "oxfmt";
import { z } from "zod";

/**
 * Builds a starter application from the Notes example and the workspace's tooling configuration.
 * It runs inside the repository only: `scripts/stage.ts` at pack time, to stage the template the
 * package ships, and `luciole init` from a checkout, to make a starter that links the checkout.
 * Nothing here reaches the consumer's machine.
 */

/** The framework package a starter depends on, and the example it is made from. */
export const FRAMEWORK_NAME = "@luciole-sh/core";
const EXAMPLE = "examples/notes";
/** Where the workspace packages a starter needs are copied, when it links the checkout. */
const VENDOR_DIR = "vendor";
/**
 * What a starter depends on beyond the Notes example's own dependencies, by name (the versions
 * are the workspace catalog's):
 * - the renderer trio is pinned together: `@opentui/keymap` asks for the exact `@opentui/core` it
 *   was released with, so a `^` range there would install a second copy beside the starter's;
 * - the optional packages Notes reaches through `@luciole-sh/core/math` and
 *   `@luciole-sh/core/grammars` (code-block highlighting); the web target's are not Notes' needs.
 */
const STARTER_DEPENDENCIES = [
  "@opentui/keymap",
  "@resvg/resvg-wasm",
  "@tree-sitter-grammars/tree-sitter-lua",
  "@tree-sitter-grammars/tree-sitter-toml",
  "@tree-sitter-grammars/tree-sitter-yaml",
  "mathjax-full",
  "tree-sitter-bash",
  "tree-sitter-c",
  "tree-sitter-cpp",
  "tree-sitter-css",
  "tree-sitter-go",
  "tree-sitter-html",
  "tree-sitter-java",
  "tree-sitter-json",
  "tree-sitter-php",
  "tree-sitter-python",
  "tree-sitter-ruby",
  "tree-sitter-rust",
  "tree-sitter-typescript",
];
/**
 * The tools a starter's scripts run (`check`, `lint`, `format`). The framework's own development
 * tooling, and the optional packages of its web target and grammars, are not the application's.
 */
const STARTER_DEV_DEPENDENCIES = [
  "@types/bun",
  "@types/react",
  "oxfmt",
  "oxlint",
  "oxlint-tsgolint",
  "typescript",
];
const CONFIG_FILES = [".oxlintrc.json", ".oxfmtrc.json", ".vscode", ".gitignore", ".bun-version"];
const STARTER_README = `# luciole starter

An application made with [luciole](https://luciole.sh), from its Notes example: a notebook kept
in SQLite on the Server, with a Markdown editor.

\`\`\`sh
bun install
bun run dev      # run it, with live reload
bun run verify   # type-check, lint, check the format, build
\`\`\`

The notes live in \`notes.sqlite\` in the directory you run it from.
`;

const Dependencies = z.record(z.string(), z.string());
/** The fields of a manifest vendoring rewrites; the rest passes through. */
const Manifest = z.looseObject({
  name: z.string().optional(),
  version: z.string().optional(),
  scripts: z.unknown().optional(),
  devDependencies: z.unknown().optional(),
  dependencies: Dependencies.optional(),
  workspaces: z.object({ catalog: Dependencies.optional() }).optional(),
});
/** The formatter options a starter's generated JSON files follow. */
const FormatterConfig = z.object({
  printWidth: z.number().int().positive(),
  sortImports: z.boolean(),
  sortPackageJson: z.boolean(),
});
const IgnoringConfig = z.looseObject({ ignorePatterns: z.array(z.string()) });

async function readJson<T>(file: string, schema: z.ZodType<T>): Promise<T> {
  let value: unknown;
  try {
    value = await Bun.file(file).json();
  } catch (error: unknown) {
    throw new Error(`${file}: invalid JSON`, { cause: error });
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`${file}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** The workspace packages by name: their directory and version (`packages/*`). */
async function workspacePackages(workspace: string) {
  const found = new Map<string, { directory: string; version?: string }>();
  for (const entry of await readdir(join(workspace, "packages")).catch((): string[] => [])) {
    const directory = join(workspace, "packages", entry);
    const manifest = await readJson(join(directory, "package.json"), Manifest).catch(
      () => undefined,
    );
    if (manifest?.name) found.set(manifest.name, { directory, version: manifest.version });
  }
  return found;
}

/**
 * How a starter names the workspace packages it depends on:
 * - `published`: `^<version>`, the range a registry serves. The packages are released in
 *   lockstep, so one that does not share the framework's version stops the staging;
 * - `workspace`: a starter that runs from this checkout. The framework is linked by `file:`;
 *   every other package is copied into the starter (`vendor/`) with its catalog pinned, because
 *   a `file:` dependency does not resolve `catalog:` inside it.
 */
export type StarterLink = "published" | "workspace";

/**
 * Writes the starter into `target`, which must be absent or empty: the Notes example's sources,
 * a package.json and tsconfig.json of its own, and the workspace's tooling configuration.
 */
export async function stageStarter(options: {
  workspace: string;
  target: string;
  link: StarterLink;
}): Promise<void> {
  const { workspace, target, link } = options;
  if ((await readdir(target).catch((): string[] => [])).length)
    throw new Error("Target already contains a project");
  await mkdir(target, { recursive: true });
  const example = join(workspace, EXAMPLE);
  await cp(example, target, {
    recursive: true,
    filter: (p) => {
      const [first = ""] = relative(example, p).split(sep);
      // `.luciole` is the build output, `.luciole-lock` its lock, `.luciole-<id>` a build's staging
      // directory (core/build.ts): none is the example's source, whatever builds it meanwhile.
      return (
        !["node_modules", "package.json", "tsconfig.json", "README.md"].includes(first) &&
        first !== ".luciole" &&
        !first.startsWith(".luciole-") &&
        !/\.sqlite(-wal|-shm)?$/.test(first)
      );
    },
  });
  const exampleManifest = await readJson(join(example, "package.json"), Manifest);
  // A starter is no workspace member: `catalog:` becomes the version the workspace pins.
  const catalog = (await readJson(join(workspace, "package.json"), Manifest)).workspaces?.catalog;
  const pinned = (dependencies: Record<string, string> = {}) =>
    Object.fromEntries(
      Object.entries(dependencies).map(([name, range]) => {
        if (range !== "catalog:") return [name, range];
        const version = catalog?.[name];
        if (!version) throw new Error(`${name}: catalog: without a version in the workspace`);
        return [name, version];
      }),
    );
  const packages = await workspacePackages(workspace);
  const framework = packages.get(FRAMEWORK_NAME);
  if (!framework?.version) throw new Error(`${FRAMEWORK_NAME}: no version in the workspace`);

  let vendored = false;
  const linked = async (name: string): Promise<string> => {
    const workspacePackage = packages.get(name);
    if (!workspacePackage) throw new Error(`${name}: no such package in the workspace`);
    if (link === "published") {
      if (workspacePackage.version !== framework.version)
        throw new Error(
          `${name} is at ${workspacePackage.version}, ${FRAMEWORK_NAME} at ${framework.version}: ` +
            "the packages are released in lockstep",
        );
      return `^${framework.version}`;
    }
    if (name === FRAMEWORK_NAME) return `file:${workspacePackage.directory}`;
    const copy = join(target, VENDOR_DIR, name.replace(/^@[^/]+\//, ""));
    await cp(workspacePackage.directory, copy, {
      recursive: true,
      // Whole path segments below the package's root: a parent directory's name is not its content.
      filter: (p) =>
        !["node_modules", "test"].includes(
          relative(workspacePackage.directory, p).split(sep)[0] ?? "",
        ),
    });
    const manifest = await readJson(join(copy, "package.json"), Manifest);
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

  const dependencies: Record<string, string> = {};
  for (const [name, range] of Object.entries(pinned(exampleManifest.dependencies)))
    dependencies[name] = range.startsWith("workspace:") ? await linked(name) : range;
  dependencies[FRAMEWORK_NAME] = await linked(FRAMEWORK_NAME);
  Object.assign(
    dependencies,
    pinned(Object.fromEntries(STARTER_DEPENDENCIES.map((name) => [name, "catalog:"]))),
  );
  if (link === "published") {
    // The scaffolder ships in the same release: it asks for the versions it was staged with.
    const create = packages.get("@luciole-sh/create");
    if (create?.version !== framework.version)
      throw new Error(
        `@luciole-sh/create is at ${create?.version}: not in lockstep with the framework`,
      );
  }
  const devDependencies = pinned(
    Object.fromEntries(STARTER_DEV_DEPENDENCIES.map((name) => [name, "catalog:"])),
  );

  await Bun.write(
    join(target, "package.json"),
    JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies,
        devDependencies,
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
    ),
  );
  await Bun.write(join(target, "README.md"), STARTER_README);
  for (const file of CONFIG_FILES)
    await cp(join(workspace, file), join(target, file), { recursive: true });
  if (vendored) {
    // The vendored copies are neither the starter's code nor to be linted or formatted.
    for (const name of [".oxlintrc.json", ".oxfmtrc.json"]) {
      const file = join(target, name);
      const config = await readJson(file, IgnoringConfig);
      config.ignorePatterns.push(`${VENDOR_DIR}/**`);
      await Bun.write(file, JSON.stringify(config, null, 2));
    }
  }
  const { printWidth, sortImports, sortPackageJson } = await readJson(
    join(workspace, ".oxfmtrc.json"),
    FormatterConfig,
  );
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
}
