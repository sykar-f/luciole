// The product's names and the commands the site prints, in one place. The names are final;
// a command lives here so that tests/docs-commands.test.ts can check it runs: the file it
// runs exists, the package it fetches is ours.
//
// The documentation (src/content/docs) writes the name as it is, so it reads as plain
// Markdown; `renameProduct` (src/lib/docs/markdown.ts) would rewrite it in every page if
// `name` and `writtenAs` differed. Links are not rewritten: the repository has its own
// address (links.ts). Props of components in MDX are JavaScript, out of the plugin's reach:
// they take the names from here (`commands`, `envPrefix`).

/** What people type and read: the CLI, directories such as `.luciole/`. */
export const name = "luciole";
/** The prefix of the environment variables (`LUCIOLE_LATENCY_MS`) and of their docs. */
export const envPrefix = name.toUpperCase();
/** The name the pages are written with. */
export const writtenAs = "luciole";

/** The packages the documentation names, as npm publishes them (docs/RELEASING.md). */
export const packages = {
  /** The install name (packages/luciole.sh): it declares the `luciole` bin and nothing else. */
  install: "luciole.sh",
  /** The scaffolder `luciole init` runs, at the framework's own version. */
  create: "@luciole-sh/create",
  /** The framework: the CLIs and the entries `@luciole-sh/core/<entry>`. */
  core: "@luciole-sh/core",
} as const;

/** The CLI's entry file in a clone of the repository. */
export const cliSource = "packages/core/src/cli.ts";

/** Commands as the documentation prints them. */
export const commands = {
  /** The CLI once the package is installed (a starter's scripts call it). */
  cli: name,
  /** The launcher that never reads its target as a subcommand, like npx. */
  runner: `${name}x`,
  /** The CLI fetched from npm and run, without installing it: how a project starts. */
  fromNpm: `bunx ${packages.install}`,
  /** The same CLI from a clone of the repository, without installing anything. */
  fromClone: `bun ${cliSource}`,
} as const;
