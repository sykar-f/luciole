/**
 * Starts, or finds again, the Server of one session key (src/launcher/lifetime.ts).
 *
 * Its socket has a stable path, `<runtime>/<sha256(key)[:16]>.sock` in a 0700 directory
 * of this user (`$XDG_RUNTIME_DIR/airtty`, else `/tmp/airtty-<uid>`): a launch of the same
 * target with the same session key finds a Server still in grace there and attaches to
 * it instead of starting another. A Server of another build is stopped and replaced.
 * The Server is detached (its own session, output to its log): it outlives the launcher,
 * a closed terminal or ssh, and ends by its own lifetime rules.
 */
import { createHash } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import * as z from "zod/mini";
import { LifetimeStatus } from "./lifetime";
import type { Directories } from "./paths";

const PRIVATE_DIRECTORY = 0o700;
const PERMISSION_BITS = 0o777;
const ID_LENGTH = 16;
const STARTUP_MS = 30_000;
const POLL_MS = 50;
const STATUS_TIMEOUT_MS = 2000;
const LOG_TAIL_BYTES = 4096;

/** The directory of this user's managed Server sockets, created 0700 and checked. */
export function runtimeDirectory(env: NodeJS.ProcessEnv = process.env) {
  const directory = env.XDG_RUNTIME_DIR
    ? join(env.XDG_RUNTIME_DIR, "airtty")
    : `/tmp/airtty-${process.getuid?.() ?? "user"}`;
  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY });
  // /tmp is shared: a directory made by someone else, or left open, is not ours to use.
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & PERMISSION_BITS) !== PRIVATE_DIRECTORY
  )
    throw new Error(`${directory} must be a directory of yours with mode 0700`);
  return directory;
}

/** The part of a session key a socket is named after. */
export const serverId = (key: string) =>
  createHash("sha256").update(key).digest("hex").slice(0, ID_LENGTH);
export const serverSocket = (id: string, env: NodeJS.ProcessEnv = process.env) =>
  join(runtimeDirectory(env), `${id}.sock`);

const request = (socket: string, path: string, method = "GET") =>
  fetch(new URL(path, "http://localhost"), {
    method,
    unix: socket,
    signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
  });

/** The managed Server listening on `socket`, or `undefined` when none answers there. */
export async function serverStatus(socket: string) {
  try {
    const response = await request(socket, "/lifetime/status");
    if (!response.ok) return undefined;
    const parsed = LifetimeStatus.safeParse(await response.json());
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function stopServer(socket: string) {
  await request(socket, "/lifetime/stop", "POST").catch(() => undefined);
  const deadline = performance.now() + STARTUP_MS;
  while ((await serverStatus(socket)) && performance.now() < deadline) await Bun.sleep(POLL_MS);
}

export type EnsureOptions = {
  /** Keys the Server: the Client's session key (`local:…`, `git:…`, `ssh:…`). */
  id: string;
  /** Its app, for the log `<state>/<name>/server.log`. */
  name: string;
  /** The build a found Server must be; another one is replaced. */
  buildId: string;
  /** Starts the Server; it reads AIRTTY_SOCKET and the lifetime variables. */
  command: readonly string[];
  graceMs: number;
  directories: Pick<Directories, "state">;
  env?: NodeJS.ProcessEnv;
  /**
   * The Client of this launch. With `attach`, the Server's stdin is a pipe held by this
   * process: its end without a leave (a crash) counts that Client lost at once.
   */
  client?: string;
  attach?: boolean;
};

export type EnsuredServer = {
  socket: string;
  url: string;
  reattached: boolean;
  pid: number;
  /** Lets go of the Server's stdin, when attached: the end of this launch. */
  release(): void;
};

export async function ensureServer(options: EnsureOptions): Promise<EnsuredServer> {
  const env = options.env ?? process.env;
  const socket = serverSocket(options.id, env);
  const found = await serverStatus(socket);
  const done = (pid: number, reattached: boolean, release = () => {}) => ({
    socket,
    url: `unix:${socket}`,
    reattached,
    pid,
    release,
  });
  if (found?.buildId === options.buildId) return done(found.pid, true);
  if (found) await stopServer(socket);
  // Nobody answers: whatever file is there is left by a Server that died.
  rmSync(socket, { force: true });
  const logFile = join(options.directories.state, options.name, "server.log");
  mkdirSync(join(options.directories.state, options.name), {
    recursive: true,
    mode: PRIVATE_DIRECTORY,
  });
  const log = openSync(logFile, "a");
  const start = statSync(logFile).size;
  const [executable, ...args] = options.command;
  if (!executable) throw new Error("No Server command");
  const child = spawn(executable, args, {
    // Its own session: a closed terminal's SIGHUP, or the launcher's end, spares it.
    detached: true,
    stdio: [options.attach ? "pipe" : "ignore", log, log],
    env: {
      ...env,
      NODE_ENV: "production",
      AIRTTY_SOCKET: socket,
      AIRTTY_LIFETIME: "managed",
      AIRTTY_GRACE_MS: String(options.graceMs),
      ...(options.client ? { AIRTTY_LIFETIME_STARTER: options.client } : {}),
    },
  });
  closeSync(log);
  child.unref();
  let exited: string | undefined;
  child.once("exit", (code, signal) => (exited = `exited with ${signal ?? code}`));
  child.once("error", (error) => (exited = error.message));
  const deadline = performance.now() + STARTUP_MS;
  for (;;) {
    const status = await serverStatus(socket);
    if (status?.buildId === options.buildId)
      return done(status.pid, status.pid !== child.pid, () => child.stdin?.destroy());
    if (exited !== undefined || performance.now() > deadline) {
      // Two launches at once: the other one's Server may have taken the socket.
      const other = await serverStatus(socket);
      if (other?.buildId === options.buildId) return done(other.pid, true);
      const text = readFileSync(logFile, "utf8").slice(start).trim();
      throw new Error(
        `${options.name}: the Server ${exited ?? `did not start in ${STARTUP_MS} ms`}` +
          (text ? `:\n${text.slice(-LOG_TAIL_BYTES)}` : "") +
          `\n(${logFile})`,
      );
    }
    await Bun.sleep(POLL_MS);
  }
}

/** A Client id, for the Server's count of its Clients. */
export const newClientId = () => crypto.randomUUID();

const EnsuredLine = z.object({
  ready: z.literal(true),
  socket: z.string(),
  pid: z.number(),
  reattached: z.boolean(),
});
/** What `<app> serve --detach` prints once its Server answers (remote hosts). */
export const formatEnsured = (server: EnsuredServer) =>
  JSON.stringify({
    ready: true,
    socket: server.socket,
    pid: server.pid,
    reattached: server.reattached,
  });
export function parseEnsured(output: string) {
  for (const line of output.split("\n")) {
    try {
      const parsed = EnsuredLine.safeParse(JSON.parse(line));
      if (parsed.success) return parsed.data;
    } catch {}
  }
  return undefined;
}
