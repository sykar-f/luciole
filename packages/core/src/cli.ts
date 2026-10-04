#!/usr/bin/env bun
import { resolve } from "node:path";
import { commands, fallback } from "./commands";
import { readFlags } from "./commands/command";
import { messageOf } from "./guards";
import { isUsageError, USAGE_EXIT_CODE } from "./args";
const args = process.argv.slice(2),
  command = args[0];
const { rest, option, optional, flag } = readFlags(args);
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
  await subcommand.run({
    args,
    rest,
    option,
    optional,
    flag,
    // Read on use: `luciole ./app --app` hands the flag to the application, not to luciole.
    get directory() {
      return resolve(option("--app", "."));
    },
  });
}
main().catch((error: unknown) => {
  console.error(messageOf(error));
  process.exitCode = isUsageError(error) ? USAGE_EXIT_CODE : 1;
});
