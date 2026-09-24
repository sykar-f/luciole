#!/usr/bin/env bun
/**
 * `airttyx <target> [app arguments]`: resolves, installs if needed and runs, like npx.
 * Unlike `airtty <target>`, the target is never read as a subcommand: `airttyx build`
 * launches an app named build.
 */
import { messageOf } from "./guards";
import { launch } from "./launcher";
import { acceptAll } from "./launcher/prompt";

const [target, ...rest] = process.argv.slice(2);
const YES = "--yes";
if (!target || target.startsWith("-")) {
  console.error("Usage: airttyx <path | app | npm spec | git source> [--yes] [app arguments]");
  process.exit(1);
}
launch(target, {
  args: rest.filter((arg) => arg !== YES),
  ...(rest.includes(YES) ? { confirm: acceptAll } : {}),
}).then(
  (code) => (process.exitCode = code),
  (error: unknown) => {
    console.error(messageOf(error));
    process.exitCode = 1;
  },
);
