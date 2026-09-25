/**
 * The entry of an app binary (`airtty build --compile`, src/compile.ts), which holds the
 * Client and the Server of one build:
 *
 *   notes [--grace d]                  both, here: the Server on a socket of this user,
 *                                      found again within its grace (src/launcher/managed.ts)
 *   notes serve [--http [host]:port | --socket path]   the Server alone
 *   notes serve --detach --id <id> [--grace d]         a managed Server in the background
 *   notes --url <url>                  the Client alone, to that Server
 *   notes --on [user@]host [--target <notes binary for host>] [--grace d]
 *                                      the Server there (installed on first use),
 *                                      the Client here, through ssh
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

/** `server` is null when the Server runs from native/server.js (src/compile.ts). */
export type Roles = { server: (() => Promise<unknown>) | null; client: () => Promise<unknown> };

const usage = (name: string) =>
  `Usage: ${name} [--grace <duration>] [--on [user@]host [--target <binary>]]\n` +
  `       ${name} --url <url>\n` +
  `       ${name} serve [--http [host]:port | --socket <path> | --detach --id <id> [--grace d]]\n` +
  `       ${name} --version`;

/** `[host]:port`; an empty host is the loopback, never every interface. */
function parseListen(value: string) {
  const match = /^(.*):(\d+)$/.exec(value);
  if (!match) throw new Error(`--http expects [host]:port, not ${value}`);
  return { host: match[1] || "127.0.0.1", port: match[2] ?? "" };
}

function flags(args: readonly string[], known: readonly string[], valued: readonly string[]) {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (valued.includes(arg)) {
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      values.set(arg, value);
    } else if (known.includes(arg)) values.set(arg, "");
    else throw new Error(`Unknown argument ${arg}`);
  }
  return values;
}

async function runClient(identity: BinaryIdentity, roles: Roles, sessionKey?: string) {
  const client = await roles.client();
  if (!isClientModule(client)) throw new Error("This binary holds no airtty Client");
  await client.run(client.createApp, { name: identity.name, sessionKey });
}

async function serve(identity: BinaryIdentity, args: readonly string[], roles: Roles) {
  const options = flags(args, ["--detach"], ["--http", "--socket", "--id", "--grace"]);
  const http = options.get("--http"),
    socket = options.get("--socket");
  if (options.has("--detach")) {
    // A managed Server in the background, found again by its id, or started (--on).
    const id = options.get("--id");
    if (!id || !/^[0-9a-f]{16}$/.test(id) || http !== undefined || socket !== undefined)
      throw new Error("serve --detach takes --id <16 hex digits> [--grace <duration>]");
    const server = await ensureServer({
      id,
      name: identity.name,
      buildId: identity.buildId,
      command: [process.execPath, "serve"],
      graceMs: grace(options),
      directories: directories(),
    });
    console.log(formatEnsured(server));
    return;
  }
  if (options.has("--id") || options.has("--grace"))
    throw new Error("--id and --grace go with --detach");
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
  const text = options.get("--grace");
  return text === undefined ? DEFAULT_GRACE_MS : parseDuration(text);
};

async function start(text: string, roles: Roles) {
  const identity = parseIdentity(text);
  if (!identity) throw new Error("Damaged binary: no identity");
  const [first, ...rest] = process.argv.slice(2);
  if (first === "serve") return serve(identity, rest, roles);
  const args = first === undefined ? [] : [first, ...rest];
  if (args.includes("--help") || args.includes("-h")) return console.log(usage(identity.name));
  if (args.includes("--version"))
    return console.log(JSON.stringify({ ...identity, identity: formatIdentity(identity) }));
  const options = flags(args, [], ["--url", "--on", "--target", "--grace"]);
  const destination = options.get("--on");
  if (options.has("--url")) {
    if (destination !== undefined || options.has("--grace"))
      throw new Error("--url goes alone: the Server is not this binary's to manage");
    // The Client reads --url itself (src/connect.ts).
    return runClient(identity, roles);
  }
  if (options.has("--target") && destination === undefined)
    throw new Error("--target goes with --on");
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
          client,
          attach: true,
        })
      : await runOn(destination, {
          identity,
          id: serverId(sessionKey),
          graceMs: grace(options),
          self: process.execPath,
          target: options.get("--target"),
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
    process.exit(1);
  }
}
