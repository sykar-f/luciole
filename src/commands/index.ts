import type { Command } from "./command";
import { install, list, remove, search, update } from "./apps";
import { build } from "./build";
import { dev } from "./dev";
import { init } from "./init";
import { launch } from "./launch";
import { pack } from "./pack";
import { runtime } from "./runtime";
import { connect, start } from "./start";
/**
 * Every `airtty` subcommand, by name. A new one is a module in this directory and one
 * line here; the order is the usage line's.
 */
export const commands: ReadonlyMap<string, Command> = new Map([
  ["init", init],
  ["dev", dev],
  ["build", build],
  ["runtime", runtime],
  ["start", start],
  ["connect", connect],
  ["search", search],
  ["install", install],
  ["update", update],
  ["list", list],
  ["remove", remove],
  ["pack", pack],
]);
/** What `airtty <target>` runs when `<target>` is no subcommand (src/launcher). */
export const fallback: Command = launch;
