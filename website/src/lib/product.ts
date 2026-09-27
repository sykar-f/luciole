// The product's name and commands, in one place: the name is not final (README), and a
// rename should be this file, not a search through every page.
//
// The documentation (src/content/docs) writes the current name as it is, so it reads as
// plain Markdown; `renameProduct` (src/lib/docs/markdown.ts) rewrites it in every page
// when `name` changes here. Links are not rewritten: the repository has its own address
// (links.ts). Props of components in MDX are JavaScript, out of the plugin's reach: they
// take the name from here (`commands`, `envPrefix`).

/** What people type and read: the CLI, the package, directories such as `.airtty/`. */
export const name = "airtty";
/** The prefix of the environment variables (`AIRTTY_LATENCY_MS`) and of their docs. */
export const envPrefix = name.toUpperCase();
/** The name the code has today, which the pages are written with. */
export const writtenAs = "airtty";

/** Commands as the documentation prints them. */
export const commands = {
  /** The CLI once the package is installed (a starter's scripts call it). */
  cli: name,
  /** The launcher that never reads its target as a subcommand, like npx. */
  runner: `${name}x`,
  /** The same CLI from a clone of the repository, without installing anything. */
  fromClone: `bun packages/${name}/src/cli.ts`,
} as const;
