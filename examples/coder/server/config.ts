import { getLaunch } from "@luciole-sh/core/server";
import cli from "../app/args";

/**
 * This Server's session, as its command line asked for it: one Server per launch
 * (package.json: "server": "per-launch"), so these are constants of the process.
 */
const args = cli.get();
export const config = {
  ...args,
  /** The project: `--cwd`, else where `coder` was typed. */
  cwd: args.cwd ?? getLaunch().cwd,
  launch: getLaunch().id,
};
