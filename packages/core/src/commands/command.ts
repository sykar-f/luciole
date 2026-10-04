import { resolve } from "node:path";
import { ArgsError } from "../args";
import { stopChild } from "../dev/supervisor";

/** What `luciole` (src/cli.ts) hands every subcommand. */
export type CommandContext = {
  /** Everything after `luciole`, the subcommand's own name first. */
  args: readonly string[];
  /** What follows `--`: the application's arguments (`luciole dev -- --flag`). */
  rest: readonly string[];
  /** A flag's value, or `fallback` when the flag is absent. Given without a value, refused. */
  option: (key: string, fallback: string) => string;
  /** A flag's value. A flag given without one is refused, never silently dropped. */
  optional: (key: string) => string | undefined;
  /** Whether a flag without a value is there. Only luciole's own, before `--`. */
  flag: (key: string) => boolean;
  /** The application directory, `--app` (default: the current directory), resolved. */
  readonly directory: string;
};

/**
 * luciole's own flags: those before `--`, since what follows is the application's. One
 * reader for all of them, so the rule holds everywhere: a flag that needs a value and gets
 * none is a usage error (exit code 2) naming the flag.
 */
export function readFlags(args: readonly string[]) {
  const end = args.indexOf("--");
  const own = end < 0 ? args : args.slice(0, end);
  const rest = end < 0 ? [] : args.slice(end + 1);
  const optional = (key: string) => {
    const i = own.indexOf(key);
    if (i < 0) return undefined;
    const value = own[i + 1];
    if (value === undefined || value.startsWith("--")) throw new ArgsError(`${key} needs a value`);
    return value;
  };
  const option = (key: string, fallback: string) => optional(key) ?? fallback;
  const flag = (key: string) => own.includes(key);
  return { rest, option, optional, flag };
}
/** A subcommand: its fragment of the usage line, and what it does. */
export type Command = { usage: string; run: (context: CommandContext) => Promise<void> };

/** The framework package (`packages/core`): `dev` reuses its packages. */
export const frameworkRoot = resolve(import.meta.dir, "../..");
/** The workspace holding it: starters copy its Notes example and tooling configuration. */
export const workspaceRoot = resolve(frameworkRoot, "../..");

/** Stops a child: SIGTERM, then SIGKILL after a grace period (src/dev/supervisor.ts). */
export const stop = stopChild;
