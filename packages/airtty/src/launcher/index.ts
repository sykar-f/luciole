/**
 * What `airtty <target>` and `airttyx <target>` launch, resolved explicitly, first match:
 *
 *   1. a path (`./notes`, `../x`, `/abs`, `~/x`): built, then run locally;
 *   2. an installed app (`notes`): its binary;
 *   3. an npm spec (`@scope/notes@1.2`, `notes@^1`): installed if needed, then run;
 *   4. a git source (`github:user/repo#ref/dir`, `https://github.com/…`, `git+ssh://…`):
 *      fetched, trusted, built, then run locally;
 *   5. a Server URL (`http(s)://`, `ssh://`): its signed bundle, opened by the generic
 *      Client (src/generic), sandboxed where the system allows it (macOS), inline only
 *      when the user says so (`--inline`).
 *
 * Arguments after the target go to the app: `--url` makes it a Client of that Server;
 * an app binary also takes `--on host` and `serve`.
 */
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { build } from "../build";
import { launchUrls } from "../generic/launch";
import { readBuildId } from "../compile";
import { binaryOf, findInstalled, install, listInstalled } from "../registry/apps";
import { npmRegistry } from "../registry/npm";
import type { Registry } from "../registry/registry";
import { DEFAULT_GRACE_MS, MS_PER_MINUTE, parseDuration } from "./lifetime";
import { readAppMetadata } from "../app-metadata";
import { planLaunch } from "./launch-key";
import {
  checkArgs,
  HELP_FLAG,
  NEW_FLAG,
  loadArgs,
  refuseArgs,
  runtimeHelp,
  splitArgs,
  type RuntimeFlag,
} from "./app-args";
import { serverId } from "./managed";
import { prepareGitApp } from "./git";
import { runForeground, runLocal } from "./local";
import { directories as defaultDirectories, type Directories } from "./paths";
import { askTerminal, type Confirm } from "./prompt";

import { ArgsError } from "../args";
import { resolveTarget } from "./target";
export { resolveTarget, type Resolution } from "./target";

export type LaunchOptions = {
  /** For the app: `--url`, `--grace`, or an app binary's own arguments. */
  args?: readonly string[];
  directories?: Directories;
  registry?: Registry;
  /** Asks before installing a package or running a repository's new commit. */
  confirm?: Confirm;
  log?: (message: string) => void;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

/** The flags a built directory takes; the rest are the application's (`app/args.ts`). */
export const BUILT_FLAGS: readonly RuntimeFlag[] = [
  { name: "url", value: "url", description: "Join a running Server (no application options)" },
  {
    name: "grace",
    value: "duration",
    description: `Keep the Server this long after its terminal goes (default ${DEFAULT_GRACE_MS / MS_PER_MINUTE}m)`,
  },
  { name: "yes", description: "Install and run without asking" },
  NEW_FLAG,
  HELP_FLAG,
];

/**
 * `--url <url>` (Client only), `--grace <duration>` (how long a local Server waits for its
 * Client to come back), `--help`, then the application's own arguments: a built directory
 * has no binary to take `--on` or `serve`.
 */
export function builtArgs(args: readonly string[]) {
  const { flags, app } = splitArgs(args, BUILT_FLAGS);
  if (app[0] === "serve" || app.includes("--on") || app.includes("--target"))
    throw new ArgsError(
      `A built app takes --url <url>, --grace <duration> and its own options (got ${args.join(" ")}); ` +
        "for --on or serve, compile it: airtty build --compile",
    );
  const url = flags.get("url");
  const grace = flags.get("grace");
  if (url !== undefined) refuseArgs(app, "--url joins one that is already running");
  return {
    url,
    graceMs: grace === undefined ? undefined : parseDuration(grace),
    help: flags.has("help"),
    fresh: flags.has("new"),
    app,
  };
}

/** Runs a directory holding `.airtty/` (from `airtty build`): locally, or as a Client. */
async function runBuilt(
  directory: string,
  name: string,
  { url, graceMs, help, fresh, app, target }: ReturnType<typeof builtArgs> & { target: string },
  options: LaunchOptions,
) {
  const bun = process.execPath;
  const client = [bun, join(directory, ".airtty/client/index.js")];
  const output = join(directory, ".airtty");
  const buildId = await readBuildId(output);
  const definition = await loadArgs(output, buildId);
  if (help) {
    console.log(
      definition?.help({
        name,
        usage: [`airtty <app> [options]`],
        runtime: runtimeHelp(BUILT_FLAGS),
      }) ?? `Usage: airtty <app> [--url <url>] [--grace <duration>]`,
    );
    return 0;
  }
  if (url) return runForeground([...client, "--url", url], options.env);
  const cwd = options.cwd ?? process.cwd();
  const args = await checkArgs(definition, app, { cwd, env: options.env, name });
  const metadata = await readAppMetadata(output);
  const plan = await planLaunch({
    name,
    target,
    scope: metadata.server ?? "shared",
    cwd,
    fingerprint: args.fingerprint,
    buildId,
    fresh,
    env: options.env,
  });
  return runLocal({
    id: serverId(plan.key),
    name,
    buildId,
    graceMs: graceMs ?? (metadata.grace ? parseDuration(metadata.grace) : DEFAULT_GRACE_MS),
    directories: options.directories ?? defaultDirectories(),
    env: { ...(options.env ?? process.env), ...args.env, ...plan.env },
    cwd,
    fingerprint: args.fingerprint,
    command: [bun, "--conditions=react-server", join(directory, ".airtty/server/index.js")],
    client,
    sessionKey: plan.key,
    session: plan.session,
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
      const parsed = builtArgs(options.args ?? []);
      if (!existsSync(join(resolution.directory, "app")))
        throw new Error(`${resolution.directory} is not an airtty app (no app/ directory)`);
      await build(resolution.directory);
      return runBuilt(
        resolution.directory,
        basename(resolution.directory),
        // The app, wherever its Server's socket is this time.
        { ...parsed, target: `local:${resolution.directory}` },
        options,
      );
    }
    case "git": {
      const parsed = builtArgs(options.args ?? []);
      const { directory } = await prepareGitApp(resolution.source, {
        directories,
        confirm,
        log,
      });
      const { url: repository, directory: inside } = resolution.source;
      // The repository, not its checkout: a new commit restores the same sessions.
      const target = `git:${repository}${inside ? `/${inside}` : ""}`;
      return runBuilt(directory, basename(directory), { ...parsed, target }, options);
    }
    case "url":
      // The generic Client: the app comes from its Server (src/generic).
      return launchUrls(resolution.url, { ...options, directories, log, confirm });
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
