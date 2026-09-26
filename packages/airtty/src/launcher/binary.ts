/**
 * The entry of an app binary (`airtty build --compile`, src/compile.ts), which holds the
 * Client and the Server of one build:
 *
 *   notes [--grace d] [app options]    both, here: the Server on a socket of this user,
 *                                      found again within its grace (src/launcher/managed.ts)
 *   notes serve [--http [host]:port | --socket path] [-- app options]   the Server alone
 *   notes serve --detach --id <id> [--grace d] [--args-stdin]
 *                                      a managed Server in the background; its
 *                                      application arguments come as a line on stdin
 *   notes --url <url>                  the Client alone, to that Server
 *   notes --on [user@]host [--target <notes binary for host>] [--grace d] [app options]
 *                                      the Server there (installed on first use),
 *                                      the Client here, through ssh
 *
 * Application options are those `app/args.ts` declares (src/args.ts): anything that is
 * not a runtime flag. `--help` lists both.
 */
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { messageOf } from "../guards";
import { NATIVE_DIRECTORY, NATIVE_SERVER } from "../native";
import { formatIdentity, parseIdentity, type BinaryIdentity } from "./identity";
import { DEFAULT_GRACE_MS, parseDuration } from "./lifetime";
import { ensureServer, formatEnsured, newClientId, serverId } from "./managed";
import { directories } from "./paths";
import { runOn } from "./remote";
import {
  ArgsError,
  decodeLaunchArgs,
  encodeLaunchArgs,
  isUsageError,
  USAGE_EXIT_CODE,
} from "../args";
import {
  checkArgs,
  definitionOf,
  HELP_FLAG,
  refuseArgs,
  runtimeHelp,
  splitArgs,
  type RuntimeFlag,
} from "./app-args";

/** What the built Client entry exports (src/build.ts). */
type ClientModule = {
  createApp: (options: Record<string, unknown>) => unknown;
  run: (
    create: (options: Record<string, unknown>) => unknown,
    options: { name: string; sessionKey?: string },
  ) => unknown;
};
const isClientModule = (value: unknown): value is ClientModule =>
  typeof value === "object" &&
  value !== null &&
  "createApp" in value &&
  typeof value.createApp === "function" &&
  "run" in value &&
  typeof value.run === "function";

/**
 * `server` is null when the Server runs from native/server.js (src/compile.ts); `args`,
 * the application's `app/args.ts`, when it declares one.
 */
export type Roles = {
  server: (() => Promise<unknown>) | null;
  client: () => Promise<unknown>;
  args?: () => Promise<unknown>;
};

const USAGE = (name: string) => [
  `${name} [--grace <duration>] [--on [user@]host [--target <binary>]] [options]`,
  `${name} --url <url>`,
  `${name} serve [--http [host]:port | --socket <path>] [-- options]`,
  `${name} --version`,
];
const RUNTIME_FLAGS: readonly RuntimeFlag[] = [
  {
    name: "grace",
    value: "duration",
    description: "Keep the Server this long after its terminal goes (default 15m)",
  },
  { name: "on", value: "[user@]host", description: "Run the Server on host, over ssh" },
  { name: "target", value: "binary", description: "This app built for the host of --on" },
  { name: "url", value: "url", description: "Join a running Server (no application options)" },
  HELP_FLAG,
  { name: "version", description: "Name, build and target" },
];
/** What `serve` takes before `--`; internal to launchers, so left out of the help. */
const SERVE_FLAGS: readonly RuntimeFlag[] = [
  { name: "http", value: "[host]:port", description: "" },
  { name: "socket", value: "path", description: "" },
  { name: "detach", description: "" },
  { name: "id", value: "id", description: "" },
  { name: "grace", value: "duration", description: "" },
  { name: "args-stdin", description: "" },
];

/** `[host]:port`; an empty host is the loopback, never every interface. */
function parseListen(value: string) {
  const match = /^(.*):(\d+)$/.exec(value);
  if (!match) throw new Error(`--http expects [host]:port, not ${value}`);
  return { host: match[1] || "127.0.0.1", port: match[2] ?? "" };
}

const definitionIn = async (roles: Roles) =>
  roles.args ? definitionOf(await roles.args()) : undefined;

/** One line of stdin: what `--on` sends a remote `serve --detach` (src/launcher/remote.ts). */
async function stdinLine() {
  let text = "";
  for await (const chunk of process.stdin) {
    text += String(chunk);
    const end = text.indexOf("\n");
    if (end >= 0) return text.slice(0, end);
  }
  return text;
}

async function runClient(identity: BinaryIdentity, roles: Roles, sessionKey?: string) {
  const client = await roles.client();
  if (!isClientModule(client)) throw new Error("This binary holds no airtty Client");
  await client.run(client.createApp, { name: identity.name, sessionKey });
}

async function serve(identity: BinaryIdentity, args: readonly string[], roles: Roles) {
  // `serve [flags] [-- application options]`: nothing else before the `--`.
  const end = args.indexOf("--");
  const { flags: options, app: unknown } = splitArgs(
    end < 0 ? args : args.slice(0, end),
    SERVE_FLAGS,
  );
  const app = end < 0 ? [] : args.slice(end + 1);
  if (unknown.length)
    throw new ArgsError(
      `Unknown argument ${unknown[0]}: serve takes ${SERVE_FLAGS.map((f) => `--${f.name}`).join(" ")}, then -- and the application's options`,
    );
  const http = options.get("http"),
    socket = options.get("socket");
  const definition = await definitionIn(roles);
  if (options.has("detach")) {
    // A managed Server in the background, found again by its id, or started (--on).
    const id = options.get("id");
    if (!id || !/^[0-9a-f]{16}$/.test(id) || http !== undefined || socket !== undefined)
      throw new Error("serve --detach takes --id <16 hex digits> [--grace <duration>]");
    // Never on the command line, which other users see: on stdin from --on.
    const launch = options.has("args-stdin") ? decodeLaunchArgs(await stdinLine()) : undefined;
    const checked = launch
      ? await checkArgs(definition, launch.argv, {
          cwd: launch.cwd ?? process.cwd(),
          name: identity.name,
        })
      : undefined;
    const server = await ensureServer({
      id,
      name: identity.name,
      buildId: identity.buildId,
      command: [process.execPath, "serve"],
      graceMs: grace(options),
      directories: directories(),
      env: { ...process.env, ...checked?.env },
    });
    console.log(formatEnsured(server));
    return;
  }
  if (options.has("id") || options.has("grace") || options.has("args-stdin"))
    throw new Error("--id, --grace and --args-stdin go with --detach");
  // `serve -- options`: this very process is the Server, which parses them (src/args.ts).
  if (app.length) {
    const checked = await checkArgs(definition, app, { cwd: process.cwd(), name: identity.name });
    Object.assign(process.env, checked.env);
  }
  if (http !== undefined && socket !== undefined)
    throw new Error("--http and --socket are exclusive");
  // The Server reads its address from its environment (src/server.ts).
  if (http !== undefined) {
    const { host, port } = parseListen(http);
    Object.assign(process.env, { AIRTTY_HOST: host, PORT: port });
    delete process.env.AIRTTY_SOCKET;
  }
  if (socket !== undefined) process.env.AIRTTY_SOCKET = resolve(socket);
  if (roles.server) return roles.server();
  // With native packages, the Server sits next to them: this binary runs it as Bun, which
  // resolves packages (a compiled binary does not). Signals and the exit code pass through.
  const native = process.env.AIRTTY_NATIVE_DIR ?? join(dirname(process.execPath), NATIVE_DIRECTORY);
  const child = spawn(process.execPath, [join(native, NATIVE_SERVER)], {
    stdio: "inherit",
    env: { ...process.env, BUN_BE_BUN: "1" },
  });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
    process.on(signal, () => child.kill(signal));
  child.once("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

const grace = (options: Map<string, string>) => {
  const text = options.get("grace");
  return text === undefined ? DEFAULT_GRACE_MS : parseDuration(text);
};

async function start(text: string, roles: Roles) {
  const identity = parseIdentity(text);
  if (!identity) throw new Error("Damaged binary: no identity");
  const [first, ...rest] = process.argv.slice(2);
  if (first === "serve") return serve(identity, rest, roles);
  const args = first === undefined ? [] : [first, ...rest];
  const { flags: options, app } = splitArgs(args, RUNTIME_FLAGS);
  const definition = await definitionIn(roles);
  if (options.has("help"))
    return console.log(
      definition?.help({
        name: identity.name,
        usage: USAGE(identity.name),
        runtime: runtimeHelp(RUNTIME_FLAGS),
      }) ?? `Usage: ${USAGE(identity.name).join(`\n       `)}`,
    );
  if (options.has("version"))
    return console.log(JSON.stringify({ ...identity, identity: formatIdentity(identity) }));
  const destination = options.get("on");
  if (options.has("url")) {
    if (destination !== undefined || options.has("grace"))
      throw new Error("--url goes alone: the Server is not this binary's to manage");
    refuseArgs(app, "--url joins one that is already running");
    // The Client reads --url itself (src/connect.ts).
    return runClient(identity, roles);
  }
  if (options.has("target") && destination === undefined)
    throw new Error("--target goes with --on");
  // Checked here, before a Server starts; the remote one gets them on stdin, with no
  // directory of this machine to resolve paths against: its own.
  const checked = await checkArgs(definition, app, {
    cwd: process.cwd(),
    name: identity.name,
  });
  // Sessions are kept under the app (and host), not the socket of this launch; the same
  // key finds a Server left in grace by a previous launch.
  const sessionKey =
    destination === undefined ? `local:${identity.name}` : `ssh:${destination}/${identity.name}`;
  const client = newClientId();
  const server =
    destination === undefined
      ? await ensureServer({
          id: serverId(sessionKey),
          name: identity.name,
          buildId: identity.buildId,
          command: [process.execPath, "serve"],
          graceMs: grace(options),
          directories: directories(),
          env: { ...process.env, ...checked.env },
          client,
          attach: true,
        })
      : await runOn(destination, {
          identity,
          id: serverId(sessionKey),
          graceMs: grace(options),
          self: process.execPath,
          target: options.get("target"),
          args: definition ? encodeLaunchArgs(app) : undefined,
          log: (message) => console.error(message),
        });
  // Handed to the Client like a user's own --url; it pings the Server as this Client.
  process.argv.push("--url", server.url);
  process.env.AIRTTY_LIFETIME_CLIENT = client;
  await runClient(identity, roles, sessionKey);
}

export async function main(identity: string, roles: Roles) {
  try {
    await start(identity, roles);
  } catch (error: unknown) {
    console.error(messageOf(error));
    process.exit(isUsageError(error) ? USAGE_EXIT_CODE : 1);
  }
}
