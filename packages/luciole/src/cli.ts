#!/usr/bin/env bun
import { resolve } from "node:path";
import { commands, fallback } from "./commands";
import { messageOf } from "./guards";
import { isUsageError, USAGE_EXIT_CODE } from "./args";
const args = process.argv.slice(2),
  command = args[0];
// luciole's own flags come before `--`; what follows is the application's.
const end = args.indexOf("--");
const own = end < 0 ? args : args.slice(0, end);
const rest = end < 0 ? [] : args.slice(end + 1);
const option = (key: string, fallback: string) => {
  const i = own.indexOf(key);
  return i < 0 ? fallback : (own[i + 1] ?? fallback);
};
/** A flag's value. A flag given without one is refused, never silently dropped. */
const optional = (key: string) => {
  const i = own.indexOf(key);
  if (i < 0) return undefined;
  const value = own[i + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${key} needs a value`);
  return value;
};
const directory = resolve(option("--app", "examples/notes"));
async function main() {
  // Anything else that is not a flag is something to launch (`luciole ./notes`); nothing
  // at all opens the launcher.
  const subcommand =
    command === undefined
      ? fallback
      : (commands.get(command) ?? (command.startsWith("-") ? undefined : fallback));
  if (!subcommand)
    throw new Error(
      `Usage: luciole ${[...commands.values(), fallback].map((c) => c.usage).join(" | ")}`,
    );
  await subcommand.run({ args, rest, option, optional, directory });
}
main().catch((error: unknown) => {
  console.error(messageOf(error));
  process.exitCode = isUsageError(error) ? USAGE_EXIT_CODE : 1;
});
