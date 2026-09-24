/**
 * What `airtty <target>` and `airttyx <target>` launch, resolved explicitly, first match:
 *
 *   1. a path (`./notes`, `../x`, `/abs`, `~/x`): built, then run locally;
 *   2. an installed app (`notes`): its binary;
 *   3. an npm spec (`@scope/notes@1.2`, `notes@^1`): installed if needed, then run;
 *   4. a git source (`github:user/repo#ref/dir`, `https://github.com/…`, `git+ssh://…`):
 *      fetched, trusted, built, then run locally;
 *   5. a Server URL (`http(s)://`, `ssh://`): not yet, there is no generic Client.
 *
 * Arguments after the target go to the app: `--url` makes it a Client of that Server;
 * an app binary also takes `--on host` and `serve`.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { build } from "../build";
import { binaryOf, findInstalled, install, listInstalled } from "../registry/apps";
import { npmRegistry } from "../registry/npm";
import { parsePackageSpec, type PackageSpec, type Registry } from "../registry/registry";
import { ATTACHED_FLAG } from "./attach";
import { parseGitSource, prepareGitApp, type GitSource } from "./git";
import { runForeground, runLocal } from "./local";
import { APP_NAME, directories as defaultDirectories, type Directories } from "./paths";
import { askTerminal, type Confirm } from "./prompt";

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

export type LaunchOptions = {
  /** For the app: `--url <url>`, or an app binary's own arguments. */
  args?: readonly string[];
  directories?: Directories;
  registry?: Registry;
  /** Asks before installing a package or running a repository's new commit. */
  confirm?: Confirm;
  log?: (message: string) => void;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

/** `--url <url>` only: a built directory has no binary to take `--on` or `serve`. */
function clientArgs(args: readonly string[]) {
  if (!args.length) return undefined;
  const [flag, url, ...rest] = args;
  if (flag !== "--url" || !url || rest.length)
    throw new Error(
      `A built app takes --url <url> only (got ${args.join(" ")}); ` +
        "for --on or serve, compile it: airtty build --compile",
    );
  return url;
}

/** Runs a directory holding `.airtty/` (from `airtty build`): locally, or as a Client. */
async function runBuilt(
  directory: string,
  name: string,
  url: string | undefined,
  options: LaunchOptions,
) {
  const bun = process.execPath;
  const client = [bun, join(directory, ".airtty/client/index.js")];
  if (url) return runForeground([...client, "--url", url], options.env);
  return runLocal({
    name,
    directories: options.directories ?? defaultDirectories(),
    env: options.env,
    command: () => [
      bun,
      "--conditions=react-server",
      join(import.meta.dir, "serve.ts"),
      join(directory, ".airtty/server/index.js"),
      ATTACHED_FLAG,
    ],
    client,
  });
}

/** Resolves `target`, prepares it, runs it in the foreground; resolves with its exit code. */
export async function launch(target: string, options: LaunchOptions = {}): Promise<number> {
  const directories = options.directories ?? defaultDirectories(options.env);
  const log = options.log ?? ((message: string) => console.error(message));
  const confirm = options.confirm ?? askTerminal;
  const resolution = resolveTarget(target, { directories, cwd: options.cwd });
  switch (resolution.kind) {
    case "path": {
      // Arguments are checked before a build, which takes a while.
      const url = clientArgs(options.args ?? []);
      if (!existsSync(join(resolution.directory, "app")))
        throw new Error(`${resolution.directory} is not an airtty app (no app/ directory)`);
      await build(resolution.directory);
      return runBuilt(resolution.directory, basename(resolution.directory), url, options);
    }
    case "git": {
      const url = clientArgs(options.args ?? []);
      const { directory } = await prepareGitApp(resolution.source, {
        directories,
        confirm,
        log,
      });
      return runBuilt(directory, basename(directory), url, options);
    }
    case "url":
      throw new Error(
        `${resolution.url}: launching from a Server URL is not supported yet ` +
          "(no generic Client). Run the app's own Client against it: " +
          `airtty <app> --url ${resolution.url}`,
      );
    case "installed": {
      const installed = await findInstalled(directories, resolution.name);
      if (!installed) throw new Error(`${target} is not installed`);
      return runForeground(
        [binaryOf(directories, installed), ...(options.args ?? [])],
        options.env,
      );
    }
    case "npm": {
      const { spec } = resolution;
      // Installed and matching: no registry round trip, so it also starts offline.
      const installed =
        (await listInstalled(directories)).find(
          (app) =>
            app.package === spec.name &&
            (spec.range === undefined || Bun.semver.satisfies(app.version, spec.range)),
        ) ??
        (
          await install(spec, {
            registry: options.registry ?? npmRegistry(),
            directories,
            log,
            confirm,
          })
        ).installed;
      return runForeground(
        [binaryOf(directories, installed), ...(options.args ?? [])],
        options.env,
      );
    }
  }
}
