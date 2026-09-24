#!/usr/bin/env bun
import { resolve } from "node:path";
import { commands } from "./commands";
import { messageOf } from "./guards";
const args = process.argv.slice(2),
  command = args[0];
const option = (key: string, fallback: string) => {
  const i = args.indexOf(key);
  return i < 0 ? fallback : args[i + 1];
};
/** A flag's value. A flag given without one is refused, never silently dropped. */
const optional = (key: string) => {
  const i = args.indexOf(key);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${key} needs a value`);
  return value;
};
const directory = resolve(option("--app", "examples/notes"));
async function main() {
  const subcommand = command === undefined ? undefined : commands.get(command);
  if (!subcommand)
    throw new Error(`Usage: airtty ${[...commands.values()].map((c) => c.usage).join(" | ")}`);
  await subcommand.run({ args, option, optional, directory });
}
main().catch((error: unknown) => {
  console.error(messageOf(error));
  process.exitCode = 1;
});
