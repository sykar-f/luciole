import { launch as launchTarget } from "../launcher";
import { acceptAll } from "../launcher/prompt";
import type { Command } from "./command";

const YES = "--yes";
/**
 * `airtty <target> [--yes] [app arguments]`: what src/cli.ts runs when the first argument
 * is no subcommand. `--yes` accepts installing and running without asking.
 */
export const launch: Command = {
  usage: "<path | app | npm spec | git source> [--yes] [--url url]",
  async run({ args }) {
    const [target, ...rest] = args;
    if (!target) throw new Error("No target to launch");
    process.exitCode = await launchTarget(target, {
      args: rest.filter((arg) => arg !== YES),
      ...(rest.includes(YES) ? { confirm: acceptAll } : {}),
    });
  },
};
