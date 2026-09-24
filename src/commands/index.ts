import type { Command } from "./command";
import { build } from "./build";
import { dev } from "./dev";
import { devtools } from "./devtools";
import { init } from "./init";
import { runtime } from "./runtime";
import { connect, start } from "./start";
/**
 * Every `airtty` subcommand, by name. A new one is a module in this directory and one
 * line here; the order is the usage line's.
 */
export const commands: ReadonlyMap<string, Command> = new Map([
  ["init", init],
  ["dev", dev],
  ["devtools", devtools],
  ["build", build],
  ["runtime", runtime],
  ["start", start],
  ["connect", connect],
]);
