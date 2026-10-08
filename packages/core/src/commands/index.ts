import { type Command, declared } from "./command";
import { install, list, remove, search, update } from "./apps";
import { build } from "./build";
import { dev } from "./dev";
import { devtools } from "./devtools";
import { example } from "./example";
import { init } from "./init";
import { keys } from "./keys";
import { launch } from "./launch";
import { pack } from "./pack";
import { runtime } from "./runtime";
import { skills } from "./skills";
import { trust } from "./trust";
import { connect, start } from "./start";
import { webRuntime } from "./web";
/**
 * Every `luciole` subcommand, by name, refusing the flags it does not declare. A new one is
 * a module in this directory and one line here; the order is the usage line's.
 */
export const commands: ReadonlyMap<string, Command> = new Map(
  (
    [
      ["init", init],
      ["dev", dev],
      ["devtools", devtools],
      ["build", build],
      ["keys", keys],
      ["trust", trust],
      ["runtime", runtime],
      ["web-runtime", webRuntime],
      ["start", start],
      ["connect", connect],
      ["search", search],
      ["install", install],
      ["update", update],
      ["list", list],
      ["remove", remove],
      ["pack", pack],
      ["skills", skills],
      ["example", example],
    ] as const
  ).map(([name, command]) => [name, declared(name, command)]),
);
/** What `luciole <target>` runs when `<target>` is no subcommand (src/launcher). */
export const fallback: Command = declared("<target>", launch);
