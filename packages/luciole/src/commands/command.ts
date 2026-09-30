import { resolve } from "node:path";
import { stopChild } from "../dev/supervisor";

/** What `luciole` (src/cli.ts) hands every subcommand. */
export type CommandContext = {
  /** Everything after `luciole`, the subcommand's own name first. */
  args: readonly string[];
  /** What follows `--`: the application's arguments (`luciole dev -- --flag`). */
  rest: readonly string[];
  /** A flag's value, or `fallback` when the flag is absent. */
  option: (key: string, fallback: string) => string;
  /** A flag's value. A flag given without one is refused, never silently dropped. */
  optional: (key: string) => string | undefined;
  /** The application directory, `--app` (default `examples/notes`), resolved. */
  directory: string;
};
/** A subcommand: its fragment of the usage line, and what it does. */
export type Command = { usage: string; run: (context: CommandContext) => Promise<void> };

/** The framework package (`packages/luciole`): `dev` reuses its packages. */
export const frameworkRoot = resolve(import.meta.dir, "../..");
/** The workspace holding it: starters copy its Notes example and tooling configuration. */
export const workspaceRoot = resolve(frameworkRoot, "../..");

/** Stops a child: SIGTERM, then SIGKILL after a grace period (src/dev/supervisor.ts). */
export const stop = stopChild;
