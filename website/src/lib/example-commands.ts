// What a reader types to run each example: after installing luciole, and from a clone of
// the repository. Apart from lib/examples.ts, so that tests/docs-commands.test.ts can read
// them without the page components that file imports.

export interface RunCommands {
  /** What a reader who installed luciole types: `luciole example <name>`, with what it needs. */
  command: string;
  /** The same from a clone of the repository, run from its root. */
  fromClone: string;
}

export const runCommands = {
  forge: { command: "luciole example forge", fromClone: "bun run forge" },
  notes: { command: "luciole example notes", fromClone: "bun run dev" },
  chat: {
    command: "OPENROUTER_API_KEY=… luciole example chat",
    fromClone: "OPENROUTER_API_KEY=… bun run chat",
  },
  mdreader: {
    command: "MD_PATH=docs luciole example mdreader",
    fromClone: "MD_PATH=docs bun run mdreader",
  },
  devtools: {
    command: "luciole devtools --demo",
    fromClone: "bun packages/core/src/cli.ts devtools --demo",
  },
  coder: {
    command: "luciole example coder -- --harness fake",
    fromClone: "bun run coder -- --harness fake",
  },
  files: { command: "luciole example files", fromClone: "bun run files" },
  mux: { command: "luciole example mux", fromClone: "bun run mux" },
} as const satisfies Record<string, RunCommands>;
