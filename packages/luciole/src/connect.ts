/**
 * Where the Client finds its Server: `--url`, then `LUCIOLE_URL`, then the user's
 * `$XDG_CONFIG_HOME/luciole/<app>.json` (`~/.config/luciole/<app>.json`), then the local
 * default. An `ssh://` URL opens a tunnel to a Server listening on the remote loopback;
 * `unix:<path>` reaches a Server on a local socket (src/launcher starts one per Client).
 */
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { connect as connectSocket } from "node:net";
import { spawn } from "node:child_process";
import * as z from "zod/mini";
import { messageOf } from "./guards";
import type { Fetch } from "./transport";

export const DEFAULT_URL = "http://127.0.0.1:3000";
/** `$XDG_CONFIG_HOME/luciole/<app>.json`: only the Server's URL for now. */
const UserConfig = z.object({ url: z.string().check(z.minLength(1)) });
// sun_path holds 104 bytes on macOS: keep the socket path below, with room for ssh.
const SOCKET_PATH_LIMIT = 100;
const SSH_ERRORS_LIMIT = 4096;
const TUNNEL_POLL_MS = 100;
const TUNNEL_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export const configPath = (name: string, env: NodeJS.ProcessEnv = process.env) =>
  join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "luciole", `${name}.json`);

export async function serverUrl({
  name,
  argv = process.argv,
  env = process.env,
}: {
  name: string;
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
}) {
  const flag = argv.indexOf("--url");
  if (flag >= 0) {
    const url = argv[flag + 1];
    if (!url) throw new Error("--url needs a value");
    return url;
  }
  if (env.LUCIOLE_URL) return env.LUCIOLE_URL;
  const path = configPath(name, env);
  const file = Bun.file(path);
  if (!(await file.exists())) return DEFAULT_URL;
  let config: unknown;
  try {
    config = JSON.parse(await file.text());
  } catch (error: unknown) {
    throw new Error(`${path}: ${messageOf(error)}`);
  }
  const parsed = UserConfig.safeParse(config);
  if (!parsed.success) throw new Error(`${path}: expected { "url": "…" }`);
  return parsed.data.url;
}

/** Where requests go, and what to stop when the Client quits. */
export type Connection = {
  url: string;
  fetch?: Fetch;
  /** The Unix socket requests go through (`unix:`, an ssh tunnel): a sandbox grants it. */
  socket?: string;
  close(): void;
  /** Present when the launcher manages the Server's lifetime (src/launcher/lifetime.ts). */
  managed?: ManagedConnection;
};
export type ManagedConnection = {
  /** Called whenever pings start or stop reaching the Server (a tunnel down, say). */
  watch(onChange: (reachable: boolean) => void): void;
  /** Tells the Server this Client quits on purpose: the last one to leave stops it. */
  leave(): Promise<void>;
};

const DEFAULT_PING_MS = 10_000;
const LEAVE_TIMEOUT_MS = 1000;
/** Set by src/launcher for a Client of a Server it manages. */
const LifetimeEnvironment = z.object({
  LUCIOLE_LIFETIME_CLIENT: z.optional(z.string().check(z.minLength(1))),
  LUCIOLE_PING_MS: z._default(z.coerce.number().check(z.gte(1)), DEFAULT_PING_MS),
});

/**
 * Pings the Server now and every `LUCIOLE_PING_MS` (10 s): the Server's watchdog hears
 * this Client, and a change in whether pings get through is reported to the Client.
 */
export function keepAlive(fetchServer: Fetch, client: string, pingMs: number): ManagedConnection {
  const listeners = new Set<(reachable: boolean) => void>();
  // The Client starts connected: a first ping that fails is a change, and is reported.
  let reachable = true;
  // Pings overlap when one outlasts the interval: an answer older than one already
  // counted says nothing new, however late it comes.
  let sent = 0;
  let counted = 0;
  const call = (path: string, signal?: AbortSignal) =>
    fetchServer(new URL(path, "http://localhost"), {
      method: "POST",
      headers: { "x-luciole-client": client },
      signal,
    });
  const ping = async () => {
    const turn = ++sent;
    const now = await call("/lifetime/ping", AbortSignal.timeout(pingMs)).then(
      (response) => response.ok,
      () => false,
    );
    if (turn < counted) return;
    counted = turn;
    if (now === reachable) return;
    reachable = now;
    for (const listener of listeners) listener(now);
  };
  void ping();
  setInterval(() => void ping(), pingMs).unref();
  return {
    watch: (onChange) => void listeners.add(onChange),
    leave: () =>
      call("/lifetime/leave", AbortSignal.timeout(LEAVE_TIMEOUT_MS)).then(
        () => undefined,
        () => undefined,
      ),
  };
}

const UNIX = "unix:";
/** Requests through a Unix socket: the host is only a name for HTTP. */
const throughSocket = (socket: string): Pick<Connection, "url" | "fetch" | "socket"> => ({
  url: "http://localhost",
  socket,
  fetch: (input, init) => fetch(input, { ...init, unix: socket }),
});

/**
 * Opens the tunnel of an `ssh://` URL, the socket of a `unix:` one; others are used as
 * is. A socket of a Server the launcher manages (LUCIOLE_LIFETIME_CLIENT) is kept alive.
 */
export function connect(
  url: string,
  options?: TunnelOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Connection> {
  if (url.startsWith("ssh://")) return openTunnel(url, options);
  if (url.startsWith(UNIX)) {
    const socket = url.slice(UNIX.length);
    if (!socket.startsWith("/"))
      return Promise.reject(new Error(`${url}: expected unix:/absolute/path`));
    const lifetime = LifetimeEnvironment.safeParse(env);
    if (!lifetime.success)
      return Promise.reject(
        new Error(`Invalid lifetime environment: ${z.prettifyError(lifetime.error)}`),
      );
    const through = throughSocket(socket);
    const client = lifetime.data.LUCIOLE_LIFETIME_CLIENT;
    return Promise.resolve({
      ...through,
      close() {},
      ...(client && through.fetch
        ? { managed: keepAlive(through.fetch, client, lifetime.data.LUCIOLE_PING_MS) }
        : {}),
    });
  }
  return Promise.resolve({ url, close() {} });
}

/**
 * A new directory only this user can enter (0700), for Unix sockets: short enough for
 * sun_path (104 bytes on macOS, with room for ssh's own suffix) and free of ":", which
 * ssh's -L splits on. `$XDG_RUNTIME_DIR` first, where the system cleans up after a crash.
 */
export function socketDirectory(prefix: string, env: NodeJS.ProcessEnv = process.env) {
  const fits = (parent: string) =>
    join(parent, `${prefix}XXXXXX/s`).length <= SOCKET_PATH_LIMIT && !parent.includes(":");
  const parent = [env.XDG_RUNTIME_DIR, tmpdir()].find((p) => p && fits(p)) ?? "/tmp";
  return mkdtempSync(join(parent, prefix));
}

export type TunnelOptions = {
  /** The ssh executable; defaults to `ssh` on PATH. */
  ssh?: string;
  /** How long authentication may take, prompts included. */
  timeoutMs?: number;
  /** Extra arguments before the destination, such as `-o ControlPath=…`. */
  options?: readonly string[];
};

const accepts = (path: string) =>
  new Promise<boolean>((resolve) => {
    const socket = connectSocket({ path });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

/**
 * `ssh://[user@]host[:port][/[remote-host:]remote-port]` reaches the Server on the remote
 * machine (`127.0.0.1:3000` by default) through `ssh -N -L`, forwarded to a Unix socket in
 * a private directory: no local port to pick, so no other process can take its place.
 * A path in a directory instead of a port (`ssh://host/run/user/1000/notes.sock`)
 * forwards to a remote Unix socket. Authentication, keys, agents and host keys follow the user's OpenSSH
 * configuration; `options` adds OpenSSH options (a shared control connection, say).
 */
export async function openTunnel(
  url: string,
  { ssh = "ssh", timeoutMs = 60000, options = [] }: TunnelOptions = {},
): Promise<Connection> {
  const parsed = new URL(url);
  const user = decodeURIComponent(parsed.username);
  const host = parsed.hostname;
  const path = decodeURIComponent(parsed.pathname);
  const remote = /^\/?(?:(.+):)?(\d+)?\/?$/.exec(path);
  // A socket's absolute path, in a directory: `/admin` stays a mistyped port.
  const remoteSocket = remote ? undefined : /^\/[^:]*[^:/]\/[^:/]+$/.exec(path)?.[0];
  if (!host || !(remote || remoteSocket) || parsed.search || parsed.hash)
    throw new Error(
      `${url}: expected ssh://[user@]host[:port][/[remote-host:]remote-port | /socket/path]`,
    );
  // ssh would read a leading dash as an option.
  if (host.startsWith("-") || user.startsWith("-") || remote?.[1]?.startsWith("-"))
    throw new Error(`${url}: host and user cannot start with "-"`);
  const directory = socketDirectory("luciole-ssh-");
  const socket = join(directory, "s");
  const child = spawn(
    ssh,
    [
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-L",
      `${socket}:${remoteSocket ?? `${remote?.[1] ?? "127.0.0.1"}:${remote?.[2] ?? "3000"}`}`,
      ...(parsed.port ? ["-p", parsed.port] : []),
      ...options,
      "--",
      user ? `${user}@${host}` : host,
    ],
    // Prompts use /dev/tty. stderr explains a failure; once the tunnel is up it is still
    // drained, never printed over the terminal interface.
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let errors = "",
    exited: string | undefined;
  child.stderr?.on("data", (chunk: Buffer) => {
    if (errors.length < SSH_ERRORS_LIMIT) errors += chunk;
  });
  child.once("error", (error) => (exited = error.message));
  child.once("exit", (code, signal) => (exited ??= `ssh exited with ${signal ?? code}`));
  const close = () => {
    process.off("exit", close);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    rmSync(directory, { recursive: true, force: true });
  };
  // The Client leaves through process.exit; the tunnel must not outlive it.
  process.on("exit", close);
  // A signal's default action skips "exit": while ssh authenticates (a passphrase can take
  // a while), stop it here, then let the signal end the process as it would have.
  const interrupted = (signal: NodeJS.Signals) => {
    ignoreSignals();
    close();
    process.kill(process.pid, signal);
  };
  const ignoreSignals = () => {
    for (const signal of TUNNEL_SIGNALS) process.off(signal, interrupted);
  };
  for (const signal of TUNNEL_SIGNALS) process.on(signal, interrupted);
  const deadline = performance.now() + timeoutMs;
  try {
    while (exited === undefined && !(await accepts(socket))) {
      if (performance.now() > deadline) {
        close();
        throw new Error(`ssh ${host}: no tunnel after ${timeoutMs} ms`);
      }
      await Bun.sleep(TUNNEL_POLL_MS);
    }
  } finally {
    ignoreSignals();
  }
  if (exited !== undefined) {
    close();
    throw new Error(`ssh ${host}: ${errors.trim() || exited}`);
  }
  return { ...throughSocket(socket), close };
}
