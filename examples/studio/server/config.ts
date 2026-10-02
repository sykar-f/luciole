import { join } from "node:path";
import { getLaunch } from "@luciole-sh/core/server";
import cli from "../app/args";
import { projectsRoot } from "./project";

const PAD = 2;
const pad = (n: number) => String(n).padStart(PAD, "0");
/** `app-20260927-1542`: a new project's name when none is given. */
function fresh(now = new Date()) {
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  return `app-${date}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/**
 * This Server's studio, as its command line asked for it: one Server per launch
 * (package.json: "server": "per-launch"), so these are constants of the process.
 */
const args = cli.get();
export const config = {
  ...args,
  /** The project directory: `--dir`, `--project` under the projects root, or a new one. */
  directory: args.dir ?? join(projectsRoot(), args.project ?? fresh()),
  launch: getLaunch().id,
};
