/**
 * Which Server a launch uses: the key its socket is named after (src/launcher/managed.ts)
 * and its Client's sessions are kept under (src/session.ts).
 *
 * An application declares its scope in its package.json (`luciole.server`):
 *
 *   shared         `<target>[#<fp>]`             one Server for every launch (Notes)
 *   per-directory  `<target>@<cwd>[#<fp>]`       one per directory the command runs in
 *   per-launch     `<target>@<cwd>[#<fp>]!<id>`  one per launch (coder: a session each)
 *
 * `<fp>` fingerprints the application's parsed arguments (src/args.ts): one Server holds
 * one set of them, so a launch never inherits another's. It is left out for applications
 * that declare none: their keys are those of earlier versions.
 *
 * A per-launch Server whose Client crashed waits in grace; the next launch with the same
 * base claims the session file that Client left (`claimOrphan`), gets its launch id back,
 * and finds the Server, its state and the Client's route and fields as they were. `--new`
 * skips that.
 */
import * as z from "zod/mini";
import { Launch, LAUNCH_VARIABLE, ServerScope } from "../launch";
export { Launch, LAUNCH_VARIABLE, launchOf, ServerScope } from "../launch";
import { claimOrphan } from "../session";
import { ARGS_VARIABLE, encodeLaunchArgs, LaunchArgs } from "../args";
import { serverSocket, serverStatus, serverId } from "./managed";

/** The part of a key every launch of the same scope, place and arguments shares. */
export function launchBase(
  target: string,
  { scope, cwd, fingerprint }: { scope: ServerScope; cwd: string; fingerprint?: string },
) {
  return `${target}${scope === "shared" ? "" : `@${cwd}`}${fingerprint ? `#${fingerprint}` : ""}`;
}
const LAUNCH_SEPARATOR = "!";

export type LaunchPlan = {
  /** The Server's key: its socket and the Client's sessions. */
  key: string;
  launch: Launch;
  /** The session file claimed from a crashed Client, for `LUCIOLE_SESSION`. */
  session?: string;
  /** The environment the Server gets: `LUCIOLE_LAUNCH`. */
  env: Record<string, string>;
};

/**
 * The key of this launch, and for a per-launch one the crashed launch it takes over:
 * one whose Server still answers, of this build, in grace.
 */
export async function planLaunch(options: {
  name: string;
  target: string;
  scope: ServerScope;
  cwd: string;
  fingerprint?: string;
  buildId: string;
  /** `--new`: never reattach. */
  fresh?: boolean;
  env?: NodeJS.ProcessEnv;
  /**
   * Whether the Server of a crashed launch still runs: by default its socket here answers
   * with this build. A remote one (`--on`) cannot be asked from here.
   */
  running?: (key: string) => Promise<boolean>;
}): Promise<LaunchPlan> {
  const { scope, cwd } = options;
  const base = launchBase(options.target, options);
  const planned = (key: string, id?: string, session?: string): LaunchPlan => {
    const launch: Launch = { v: 1, scope, cwd, ...(id ? { id } : {}) };
    return { key, launch, session, env: { [LAUNCH_VARIABLE]: JSON.stringify(launch) } };
  };
  if (scope !== "per-launch") return planned(base);
  const prefix = base + LAUNCH_SEPARATOR;
  const claimed = options.fresh
    ? undefined
    : await claimOrphan({
        name: options.name,
        env: options.env,
        async accept(server) {
          if (!server.startsWith(prefix)) return false;
          if (options.running) return options.running(server);
          const status = await serverStatus(serverSocket(serverId(server), options.env));
          return status?.buildId === options.buildId;
        },
      });
  if (claimed) return planned(claimed.server, claimed.server.slice(prefix.length), claimed.id);
  const id = crypto.randomUUID();
  return planned(prefix + id, id);
}

/**
 * What `--on` sends a remote `serve --detach` on its stdin (src/launcher/remote.ts): the
 * application's arguments and the launch, whose directory is the remote one.
 */
export const RemoteLaunch = z.object({
  args: z.optional(LaunchArgs),
  launch: z.optional(z.object({ scope: ServerScope, id: z.optional(z.string()) })),
});
export type RemoteLaunch = z.infer<typeof RemoteLaunch>;
/** The remote Server's environment, from what `--on` sent, in its own directory. */
export function remoteEnvironment(line: string, cwd: string): Record<string, string> {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("serve --env-stdin: the line on stdin is not JSON");
  }
  const parsed = RemoteLaunch.safeParse(value);
  if (!parsed.success) throw new Error(`serve --env-stdin: ${z.prettifyError(parsed.error)}`);
  const { args, launch } = parsed.data;
  return {
    ...(args ? { [ARGS_VARIABLE]: encodeLaunchArgs(args.argv, args.cwd ?? cwd) } : {}),
    ...(launch
      ? { [LAUNCH_VARIABLE]: JSON.stringify({ v: 1, ...launch, cwd } satisfies Launch) }
      : {}),
  };
}
