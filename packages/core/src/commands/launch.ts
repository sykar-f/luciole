import { BUILT_FLAGS, launch as launchTarget } from "../launcher";
import { openLauncher } from "../launcher/home";
import { acceptAll } from "../launcher/prompt";
import { type Command, type FlagKind, readFlags } from "./command";

const YES = "--yes";
/**
 * Reads luciole's `--yes` from the arguments of a launch and hands back the rest. Like every
 * luciole flag it stops at `--`: an application's own `--yes` stays among its arguments.
 */
export function takeYes(args: readonly string[]) {
  const yes = readFlags(args).flag(YES);
  const end = args.indexOf("--");
  const own = end < 0 ? args : args.slice(0, end);
  const after = end < 0 ? [] : args.slice(end);
  return {
    args: [...own.filter((arg) => arg !== YES), ...after],
    confirm: yes ? { confirm: acceptAll } : {},
  };
}
/**
 * `luciole <target> [--yes] [app arguments]`: what src/cli.ts runs when the first argument
 * is no subcommand. `--yes` accepts installing and running without asking. Without a
 * target, the launcher UI opens.
 */
export const launch: Command = {
  usage:
    "[<path | app | npm spec | git source> [--yes] [--url url] | <server url…> [--inline | --sandbox] [--allow-…] [--yes]]",
  // The flags the launcher reads (src/launcher, src/generic); `--allow-…` stands for the
  // capabilities a Server URL is granted (src/sandbox/grants.ts).
  flags: {
    ...Object.fromEntries(
      BUILT_FLAGS.flatMap(({ name, short, value }) => [
        [`--${name}`, value ? "value" : "switch"] as const,
        ...(short ? [[`-${short}`, "switch"] as const] : []),
      ]),
    ),
    "--inline": "switch",
    "--sandbox": "switch",
    "--allow-…": "switch",
  } satisfies Record<string, FlagKind>,
  forwards: true,
  async run({ args }) {
    const [target, ...rest] = args;
    const { args: appArgs, confirm } = takeYes(rest);
    process.exitCode = target
      ? await launchTarget(target, { args: appArgs, ...confirm })
      : await openLauncher(confirm);
  },
};
