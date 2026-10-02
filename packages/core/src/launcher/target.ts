/**
 * Which kind of target a launch names, first match: a path, an installed app, an npm
 * spec, a git source, a Server URL (see index.ts). Pure but for one `existsSync`: the
 * launcher UI's Server checks a target with it before handing it over.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parsePackageSpec, type PackageSpec } from "../registry/registry";
import { parseGitSource, type GitSource } from "./git-source";
import { APP_NAME, directories as defaultDirectories } from "./paths";

export type Resolution =
  | { kind: "path"; directory: string }
  | { kind: "installed"; name: string }
  | { kind: "npm"; spec: PackageSpec }
  | { kind: "git"; source: GitSource }
  | { kind: "url"; url: string };

const PATH = /^(?:\.{1,2}|~)?\//;
const SERVER_URL = /^(?:https?|ssh):\/\//;

export function resolveTarget(
  target: string,
  { directories = defaultDirectories(), cwd = process.cwd() } = {},
): Resolution {
  if (PATH.test(target) || target === "." || target === "..")
    return {
      kind: "path",
      directory: target.startsWith("~/") ? join(homedir(), target.slice(2)) : resolve(cwd, target),
    };
  if (APP_NAME.test(target) && existsSync(join(directories.apps, target, "installed.json")))
    return { kind: "installed", name: target };
  const spec = parsePackageSpec(target);
  if (spec) return { kind: "npm", spec };
  const source = parseGitSource(target);
  if (source) return { kind: "git", source };
  if (SERVER_URL.test(target)) return { kind: "url", url: target };
  throw new Error(
    `${target}: not a path (start it with ./), an installed app, an npm package, ` +
      "a git source (github:user/repo, git+https://…) or a Server URL",
  );
}
