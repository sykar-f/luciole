import { launch as launchTarget } from "../launcher";
import { openLauncher } from "../launcher/home";
import { acceptAll } from "../launcher/prompt";
import type { Command } from "./command";

const YES = "--yes";
/**
 * `luciole <target> [--yes] [app arguments]`: what src/cli.ts runs when the first argument
 * is no subcommand. `--yes` accepts installing and running without asking. Without a
 * target, the launcher UI opens.
 */
export const launch: Command = {
  usage:
    "[<path | app | npm spec | git source> [--yes] [--url url] | <server url…> [--inline | --sandbox] [--allow-…] [--yes]]",
  async run({ args }) {
    const [target, ...rest] = args;
    const confirm = rest.includes(YES) ? { confirm: acceptAll } : {};
    process.exitCode = target
      ? await launchTarget(target, { args: rest.filter((arg) => arg !== YES), ...confirm })
      : await openLauncher(confirm);
  },
};
