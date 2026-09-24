/**
 * The entry of an app binary (`airtty build --compile`, src/compile.ts), which holds the
 * Client and the Server of one build:
 *
 *   notes                              both, here: the Server on a private socket
 *   notes serve [--http [host]:port | --socket path]   the Server alone
 *   notes --url <url>                  the Client alone, to that Server
 *   notes --on [user@]host [--target <notes binary for host>]
 *                                      the Server there (installed on first use),
 *                                      the Client here, through ssh
 */
import { resolve } from "node:path";
import { messageOf } from "../guards";
import { ATTACHED_FLAG, exitWithStdin } from "./attach";
import { formatIdentity, parseIdentity, type BinaryIdentity } from "./identity";
import { startServer } from "./local";
import { directories } from "./paths";
import { runOn } from "./remote";

/** What the built Client entry exports (src/build.ts). */
type ClientModule = {
  createApp: (options: Record<string, unknown>) => unknown;
  run: (
    create: (options: Record<string, unknown>) => unknown,
    options: { name: string },
  ) => unknown;
};
const isClientModule = (value: unknown): value is ClientModule =>
  typeof value === "object" &&
  value !== null &&
  "createApp" in value &&
  typeof value.createApp === "function" &&
  "run" in value &&
  typeof value.run === "function";

export type Roles = { server: () => Promise<unknown>; client: () => Promise<unknown> };

const usage = (name: string) =>
  `Usage: ${name} [--url <url> | --on [user@]host [--target <binary>]]\n` +
  `       ${name} serve [--http [host]:port | --socket <path>]\n` +
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

async function runClient(identity: BinaryIdentity, roles: Roles) {
  const client = await roles.client();
  if (!isClientModule(client)) throw new Error("This binary holds no airtty Client");
  await client.run(client.createApp, { name: identity.name });
}

async function serve(args: readonly string[], roles: Roles) {
  const options = flags(args, [ATTACHED_FLAG], ["--http", "--socket"]);
  const http = options.get("--http"),
    socket = options.get("--socket");
  if (http !== undefined && socket !== undefined)
    throw new Error("--http and --socket are exclusive");
  // The Server reads its address from its environment (src/server.ts).
  if (http !== undefined) {
    const { host, port } = parseListen(http);
    Object.assign(process.env, { AIRTTY_HOST: host, PORT: port });
    delete process.env.AIRTTY_SOCKET;
  }
  if (socket !== undefined) process.env.AIRTTY_SOCKET = resolve(socket);
  if (options.has(ATTACHED_FLAG)) exitWithStdin();
  await roles.server();
}

async function start(text: string, roles: Roles) {
  const identity = parseIdentity(text);
  if (!identity) throw new Error("Damaged binary: no identity");
  const [first, ...rest] = process.argv.slice(2);
  if (first === "serve") return serve(rest, roles);
  const args = first === undefined ? [] : [first, ...rest];
  if (args.includes("--help") || args.includes("-h")) return console.log(usage(identity.name));
  if (args.includes("--version"))
    return console.log(JSON.stringify({ ...identity, identity: formatIdentity(identity) }));
  const options = flags(args, [], ["--url", "--on", "--target"]);
  const destination = options.get("--on");
  if (options.has("--url")) {
    if (destination !== undefined) throw new Error("--url and --on are exclusive");
    // The Client reads --url itself (src/connect.ts).
    return runClient(identity, roles);
  }
  if (options.has("--target") && destination === undefined)
    throw new Error("--target goes with --on");
  const server =
    destination === undefined
      ? await startServer({
          name: identity.name,
          command: () => [process.execPath, "serve", ATTACHED_FLAG],
          directories: directories(),
        })
      : await runOn(destination, {
          identity,
          self: process.execPath,
          target: options.get("--target"),
          directories: directories(),
          log: (message) => console.error(message),
        });
  // Handed to the Client like a user's own --url; the Server stops when it exits.
  process.argv.push("--url", server.url);
  await runClient(identity, roles);
}

export async function main(identity: string, roles: Roles) {
  try {
    await start(identity, roles);
  } catch (error: unknown) {
    console.error(messageOf(error));
    process.exit(1);
  }
}
