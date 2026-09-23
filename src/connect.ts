/**
 * Where the Client finds its Server: `--url`, then `AIRTTY_URL`, then the user's
 * `$XDG_CONFIG_HOME/airtty/<app>.json` (`~/.config/airtty/<app>.json`), then the local
 * default. An `ssh://` URL opens a tunnel to a Server listening on the remote loopback.
 */
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { connect as connectSocket } from "node:net";
import { spawn } from "node:child_process";

export const DEFAULT_URL = "http://127.0.0.1:3000";

export const configPath = (name: string, env: NodeJS.ProcessEnv = process.env) =>
  join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "airtty", `${name}.json`);

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
  if (env.AIRTTY_URL) return env.AIRTTY_URL;
  const path = configPath(name, env);
  const file = Bun.file(path);
  if (!(await file.exists())) return DEFAULT_URL;
  let config: unknown;
  try {
    config = JSON.parse(await file.text());
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const url =
    typeof config === "object" && config !== null && "url" in config ? config.url : undefined;
  if (typeof url !== "string" || !url) throw new Error(`${path}: expected { "url": "…" }`);
  return url;
}

/** Where requests go, and what to stop when the Client quits. */
export type Connection = { url: string; fetch?: typeof fetch; close(): void };

/** Opens the tunnel of an `ssh://` URL; any other URL is used as is. */
export function connect(url: string, options?: TunnelOptions): Promise<Connection> {
  return url.startsWith("ssh://") ? openTunnel(url, options) : Promise.resolve({ url, close() {} });
}

export type TunnelOptions = {
  /** The ssh executable; defaults to `ssh` on PATH. */
  ssh?: string;
  /** How long authentication may take, prompts included. */
  timeoutMs?: number;
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
 * Authentication, keys, agents and host keys follow the user's OpenSSH configuration.
 */
export async function openTunnel(
  url: string,
  { ssh = "ssh", timeoutMs = 60000 }: TunnelOptions = {},
): Promise<Connection> {
  const parsed = new URL(url);
  const user = decodeURIComponent(parsed.username);
  const host = parsed.hostname;
  const remote = /^\/?(?:(.+):)?(\d+)?\/?$/.exec(decodeURIComponent(parsed.pathname));
  if (!host || !remote || parsed.search || parsed.hash)
    throw new Error(`${url}: expected ssh://[user@]host[:port][/[remote-host:]remote-port]`);
  // ssh would read a leading dash as an option.
  if (host.startsWith("-") || user.startsWith("-") || remote[1]?.startsWith("-"))
    throw new Error(`${url}: host and user cannot start with "-"`);
  // A socket path must fit sun_path (104 bytes on macOS) and ssh splits -L on ":".
  const base = join(tmpdir(), "airtty-ssh-XXXXXX/s");
  const directory = mkdtempSync(
    join(base.length > 100 || base.includes(":") ? "/tmp" : tmpdir(), "airtty-ssh-"),
  );
  const socket = join(directory, "s");
  const child = spawn(
    ssh,
    [
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-L",
      `${socket}:${remote[1] ?? "127.0.0.1"}:${remote[2] ?? "3000"}`,
      ...(parsed.port ? ["-p", parsed.port] : []),
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
    if (errors.length < 4096) errors += chunk;
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
  const deadline = performance.now() + timeoutMs;
  while (exited === undefined && !(await accepts(socket))) {
    if (performance.now() > deadline) {
      close();
      throw new Error(`ssh ${host}: no tunnel after ${timeoutMs} ms`);
    }
    await Bun.sleep(100);
  }
  if (exited !== undefined) {
    close();
    throw new Error(`ssh ${host}: ${errors.trim() || exited}`);
  }
  return {
    // The host is only a name for HTTP; bytes go through the socket.
    url: "http://localhost",
    fetch: Object.assign(
      (input: string | URL | Request, init?: RequestInit) =>
        fetch(input, { ...init, unix: socket }),
      { preconnect: fetch.preconnect },
    ),
    close,
  };
}
