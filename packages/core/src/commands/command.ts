import { resolve } from "node:path";
import { ArgsError, suggest } from "../args";
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
/** A flag before `--`: a switch stands alone, a value flag takes the next word. */
export type FlagKind = "switch" | "value";
/** A subcommand: its fragment of the usage line, the flags it reads, and what it does. */
export type Command = {
  usage: string;
  /** Every flag it reads before `--`: any other is a usage error, unless it `forwards`. */
  flags: Readonly<Record<string, FlagKind>>;
  /**
   * The words it does not read are the application's (`luciole ./app --mode x`): the
   * application's own parser refuses those it does not know, so they are not refused here.
   */
  forwards?: true;
  run: (context: CommandContext) => Promise<void>;
};

/**
 * `command` as `luciole <name>` runs it. A flag before `--` it does not declare is a usage
 * error naming it, before anything runs: a typo never runs a command without the option
 * meant. Reading a flag it does not declare is a bug of the command, refused as one.
 */
export function declared(name: string, command: Command): Command {
  const reads = (key: string, value: boolean) => {
    const kind = kindOf(command, key);
    if (!kind || (value && kind !== "value"))
      throw new Error(
        `luciole ${name} reads ${key}${value ? " as a value" : ""} without declaring it so`,
      );
  };
  return {
    ...command,
    run(context) {
      if (!command.forwards) refuseUnknown(name, command, context.args);
      return command.run({
        args: context.args,
        rest: context.rest,
        flag: (key) => (reads(key, false), context.flag(key)),
        optional: (key) => (reads(key, true), context.optional(key)),
        option: (key, fallback) => (reads(key, true), context.option(key, fallback)),
        get directory() {
          reads("--app", true);
          return context.directory;
        },
      });
    },
  };
}
const kindOf = (command: Command, key: string) =>
  Object.hasOwn(command.flags, key) ? command.flags[key] : undefined;
function refuseUnknown(name: string, command: Command, args: readonly string[]) {
  const end = args.indexOf("--");
  // The subcommand's own name comes first.
  const own = (end < 0 ? args : args.slice(0, end)).slice(1);
  for (let i = 0; i < own.length; i++) {
    const word = own[i] ?? "";
    const kind = kindOf(command, word);
    if (kind === "value") i++;
    else if (!kind && word.startsWith("-") && word !== "-") {
      const near = suggest(word, Object.keys(command.flags));
      throw new ArgsError(
        `Unknown flag ${word} for luciole ${name}${near ? ` (did you mean ${near}?)` : ""}\n` +
          `Usage: luciole ${command.usage}`,
      );
    }
  }
}

/** The framework package (`packages/core`): `dev` reuses its packages. */
export const frameworkRoot = resolve(import.meta.dir, "../..");
/** The workspace holding it: starters copy its Notes example and tooling configuration. */
export const workspaceRoot = resolve(frameworkRoot, "../..");

/** Stops a child: SIGTERM, then SIGKILL after a grace period (src/dev/supervisor.ts). */
export const stop = stopChild;
