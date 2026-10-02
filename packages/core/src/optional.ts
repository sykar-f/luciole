/**
 * Optional dependencies: what a feature needs and an app that never uses it does not
 * install (`peerDependenciesMeta`, docs/DEPENDENCIES.md). Without one, the feature says
 * which package to add instead of failing on a bare resolution error.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** What `@luciole-sh/core/grammars` bundles: the build checks them before it resolves the module. */
export const GRAMMAR_PACKAGES = [
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
  "@tree-sitter-grammars/tree-sitter-lua",
  "@tree-sitter-grammars/tree-sitter-toml",
  "@tree-sitter-grammars/tree-sitter-yaml",
] as const;
/** The web runtime bundles xterm.js. */
export const WEB_RUNTIME_PACKAGES = [
  "@xterm/xterm",
  "@xterm/addon-fit",
  "@xterm/addon-webgl",
] as const;
/** The web target's Worker ships SQLite. */
export const WEB_SERVER_PACKAGES = ["@sqlite.org/sqlite-wasm"] as const;

/** The package a resolution error is about, or undefined when it is some other error. */
function missingPackage(error: unknown, candidates: readonly string[]) {
  if (!(error instanceof Error)) return undefined;
  const code = "code" in error ? error.code : undefined;
  if (
    code !== "ERR_MODULE_NOT_FOUND" &&
    code !== "MODULE_NOT_FOUND" &&
    error.name !== "ResolveMessage"
  ) {
    return undefined;
  }
  return candidates.find((name) => error.message.includes(name));
}

function notInstalled(feature: string, name: string, cause: unknown) {
  return new Error(
    `${feature} needs the optional package ${name}, which is not installed: run \`bun add ${name}\``,
    { cause },
  );
}

/** `load()` (a dynamic `import()` of `name`), or an error telling to install `name`. */
export async function loadOptional<T>(
  feature: string,
  name: string,
  load: () => Promise<T>,
): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if (missingPackage(error, [name])) throw notInstalled(feature, name, error);
    throw error;
  }
}

/** For code a bundler resolves later: fails now, naming the first package not installed. */
export function assertInstalled(feature: string, names: readonly string[]) {
  for (const name of names) {
    try {
      require.resolve(`${name}/package.json`);
    } catch (error) {
      // A package whose `exports` hides package.json still resolves by its main file.
      try {
        require.resolve(name);
      } catch {
        throw notInstalled(feature, name, error);
      }
    }
  }
}
