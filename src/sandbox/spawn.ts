/**
 * One sandboxed origin (docs/EMBEDDING.md, section 5), from the host's side: the route to
 * its Server, the egress proxy, a private scratch directory, then its Client started
 * under Seatbelt on a PTY the VT widget shows, with an IPC channel for the capabilities
 * the host mediates. Everything is set up before the child starts (the proxy listens,
 * its port is held) and torn down after it ends.
 */
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Capabilities } from "../capabilities";
import { connect, type Connection } from "../connect";
import type { CapabilityState, HostEvent, HostRequest, MediatedCapability } from "../host";
import { sessionDirectory } from "../session";
import { spawnPty, type Pty } from "../vt/pty";
import type { TerminalIo } from "../vt/terminal";
import { answer } from "./ipc";
import { createPermissions, type Permissions, type Question } from "./permissions";
import { sandboxed, seatbeltProfile, type SandboxRuntime, type ServerRoute } from "./profile";
import { startProxy, type EgressProxy } from "./proxy";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const DEFAULT_PORTS: Record<string, number> = { "http:": 80, "https:": 443 };
// Passed through: how the user reads text and time, nothing that names a secret or a path.
const PASSED = ["LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TZ"];

export type SandboxOrigin = {
  origin: string;
  /** The Server's URL, as the user gave it. */
  url: string;
  /** `<origin>/app`: the manifest as received and a link to the cached bundle. */
  app: string;
  /** The publisher key pinned for the origin: the child refuses any other. */
  fingerprint: string;
  /** `openSession` name of the origin's sessions. */
  sessions: string;
  granted: Capabilities;
  /** What the user refused: capability names, `secrets:<name>` (origin.json). */
  denied?: readonly string[];
  /**
   * Bun, airtty and the built child (src/sandbox/runtime.ts), found by the launcher, which
   * runs from airtty's sources: this module also runs inside the bundled generic Client.
   */
  runtime: SandboxRuntime;
  child: string;
};
export type SandboxOptions = {
  /** Performs a granted request (src/host.ts, `performDirectly` or the host's tabs). */
  perform: (request: HostRequest) => Promise<unknown>;
  /** `XDG_STATE_HOME` whose `airtty/<sessions>/sessions` the child writes. */
  env?: NodeJS.ProcessEnv;
  /** Asks the user about a capability the origin has not been granted nor refused. */
  ask?: (question: Question) => Promise<boolean>;
  /** A decision the user made (to remember); the child is told already. */
  onChange?: (change: { capability: MediatedCapability; state: CapabilityState }) => void;
  /** Tests: maps a proxied name to the address actually dialled. */
  resolve?: (host: string) => string;
  /** Tests: sees the profile generated for the child. */
  onProfile?: (profile: string) => void;
};
export type Sandbox = {
  /** Starts the child; the VT widget calls it once it knows its size. */
  spawn(io: TerminalIo): Pty;
  /** An event for the child, sent only when its grants let it hear it. */
  deliver(event: HostEvent): void;
  /** Where its mediated capabilities stand, as the user decides. */
  readonly permissions: Permissions;
  readonly proxy: EgressProxy | undefined;
  close(): Promise<void>;
};

/** How the child reaches the Server, and the URL it is given for it. */
function routeOf(
  url: string,
  connection: Connection,
): { route: ServerRoute; url: string; allow?: string } {
  if (connection.socket)
    return { route: { kind: "socket", path: connection.socket }, url: `unix:${connection.socket}` };
  const parsed = new URL(url);
  const port = Number(parsed.port) || DEFAULT_PORTS[parsed.protocol];
  if (!port) throw new Error(`${url}: no port to reach`);
  // The child resolves no name: localhost is given as an address.
  if (LOOPBACK.has(parsed.hostname)) {
    parsed.hostname = "127.0.0.1";
    return { route: { kind: "loopback", port }, url: parsed.href };
  }
  return { route: { kind: "proxy" }, url, allow: `${parsed.hostname}:${port}` };
}

export async function openSandbox(
  origin: SandboxOrigin,
  options: SandboxOptions,
): Promise<Sandbox> {
  const env = options.env ?? process.env;
  const { granted, runtime } = origin;
  const connection = await connect(origin.url, undefined, env);
  let proxy: EgressProxy | undefined;
  let tmp: string | undefined;
  try {
    const server = routeOf(origin.url, connection);
    const anyHost = granted.net.includes("*");
    if (!anyHost && (granted.net.length || server.allow))
      proxy = await startProxy({
        allow: [...granted.net, ...(server.allow ? [server.allow] : [])],
        resolve: options.resolve,
      });
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "airtty-sandbox-")));
    const sessions = sessionDirectory(origin.sessions, env);
    mkdirSync(sessions, { recursive: true, mode: 0o700 });
    // The manifest, and the cached bundle its link points to.
    const readable = [
      origin.app,
      ...readdirSync(origin.app).map((f) => realpathSync(join(origin.app, f))),
    ];
    const proxyUrl = proxy && `http://127.0.0.1:${proxy.port}`;
    const childEnv: Record<string, string> = {
      PATH: "/usr/bin:/bin",
      HOME: tmp,
      TMPDIR: tmp,
      // Where sessionDirectory() put the origin's sessions, which the profile opens.
      XDG_STATE_HOME: env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
      // Nothing to cache: the child could not write it anyway.
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      ...Object.fromEntries(PASSED.flatMap((name) => (env[name] ? [[name, env[name]]] : []))),
      ...(proxyUrl && {
        HTTP_PROXY: proxyUrl,
        HTTPS_PROXY: proxyUrl,
        // A loopback Server is reached directly (the profile allows its port).
        NO_PROXY: server.route.kind === "loopback" ? "127.0.0.1" : "",
      }),
    };
    const permissions = createPermissions({
      granted,
      denied: origin.denied,
      ask: options.ask,
      onChange: (change) => {
        child?.send({ kind: "event", event: { type: "capability", ...change } });
        options.onChange?.(change);
      },
    });
    const argv = [
      origin.child,
      "--url",
      server.url,
      "--bundle",
      origin.app,
      "--origin",
      origin.origin,
      "--sessions",
      origin.sessions,
      "--publisher",
      origin.fingerprint,
    ];
    let child: Pty | undefined;
    const scratch = tmp;
    // A host that quits through process.exit unmounts nothing: the child, which has its
    // own session, must not outlive it, nor its scratch directory.
    const exit = () => {
      child?.kill();
      rmSync(scratch, { recursive: true, force: true });
    };
    process.on("exit", exit);
    return {
      proxy,
      permissions,
      spawn: (io) => {
        child = spawnPty({
          ...io,
          cwd: scratch,
          env: childEnv,
          environment: "replace",
          command: (tty) => {
            const profile = seatbeltProfile({
              runtime,
              capabilities: granted,
              tmp: scratch,
              readable,
              writable: [sessions],
              tty,
              server: server.route,
              proxyPort: proxy?.port,
            });
            options.onProfile?.(profile);
            return sandboxed(profile, [
              runtime.bun,
              ...argv,
              "--capabilities",
              JSON.stringify(permissions.states()),
            ]);
          },
          ipc: (message) =>
            void answer(message, (request) => permissions.allow(request), options.perform).then(
              (reply) => {
                if (reply) child?.send(reply);
              },
            ),
        });
        return child;
      },
      deliver: (event) => {
        if (permissions.hears(event)) child?.send({ kind: "event", event });
      },
      close: async () => {
        process.off("exit", exit);
        exit();
        connection.close();
        await proxy?.stop();
      },
    };
  } catch (error: unknown) {
    connection.close();
    await proxy?.stop();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
}
