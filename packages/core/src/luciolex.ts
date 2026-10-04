#!/usr/bin/env bun
/**
 * `luciolex <target> [app arguments]`: resolves, installs if needed and runs, like npx.
 * Unlike `luciole <target>`, the target is never read as a subcommand: `luciolex build`
 * launches an app named build. `--yes` is luciolex's own only before `--`, as for luciole.
 */
import { isUsageError, USAGE_EXIT_CODE } from "./args";
import { messageOf } from "./guards";
import { takeYes } from "./commands/launch";
import { launch } from "./launcher";

const [target, ...rest] = process.argv.slice(2);
if (!target || target.startsWith("-")) {
  console.error("Usage: luciolex <path | app | npm spec | git source> [--yes] [-- app arguments]");
  process.exit(USAGE_EXIT_CODE);
}
const { args, confirm } = takeYes(rest);
launch(target, { args, ...confirm }).then(
  (code) => (process.exitCode = code),
  (error: unknown) => {
    console.error(messageOf(error));
    process.exitCode = isUsageError(error) ? USAGE_EXIT_CODE : 1;
  },
);
