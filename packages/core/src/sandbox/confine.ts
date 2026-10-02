/**
 * Everything a sandboxed child needs around it, whatever the mechanism
 * (src/sandbox/mechanism.ts): the route to its application's Server, which is always
 * allowed, the egress proxy for the hosts it was granted, and the command that starts it
 * confined. All of it is set up before the child starts (a proxy listens, its port or
 * socket is held) and torn down after it ends.
 *
 * - Seatbelt: the Server's loopback port (or the ssh tunnel's socket) and the proxy's
 *   port, by the profile (src/sandbox/profile.ts).
 * - Linux with a network namespace (`userns`, `bwrap`): only loopback exists inside; the
 *   launcher relays 127.0.0.1:3000 to the Server and 127.0.0.1:3128 to the proxy, both
 *   Unix sockets of the host (seccomp refuses the child Unix sockets of its own).
 * - Linux `landlock`: TCP to the Server's port and the proxy's port only, but to any
 *   address; what the capabilities screen says.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capabilities } from "../capabilities";
import type { Connection } from "../connect";
import { bridge, type Bridge, type Target } from "./bridge";
import { linuxCommand, type LinuxNetwork } from "./linux";
import type { Mechanism } from "./mechanism";
import { sandboxed, seatbeltProfile, type SandboxRuntime, type ServerRoute } from "./profile";
import { startProxy, type EgressProxy } from "./proxy";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const DEFAULT_PORTS: Record<string, number> = { "http:": 80, "https:": 443 };
/** Inside a network namespace, where the launcher's relays listen. */
export const RELAYED_SERVER_PORT = 3000;
export const RELAYED_PROXY_PORT = 3128;

export type ConfineOptions = {
  mechanism: Mechanism;
  runtime: SandboxRuntime;
  granted: Capabilities;
  /** The child's scratch directory (TMPDIR, HOME), read-write. */
  tmp: string;
  readable: readonly string[];
  writable: readonly string[];
  /** The Server as the user named it, and the connection the host opened to it. */
  server: { url: string; connection: Connection };
  /** Tests: maps a proxied name to the address actually dialled. */
  resolve?: (host: string) => string;
  /** Tests: sees the profile or policy generated. */
  onProfile?: (profile: string) => void;
};
export type Confinement = {
  /** argv running `argv` confined, on the PTY whose slave is `tty`. */
  command(tty: string, argv: readonly string[]): string[];
  /** The Server's URL for the child. */
  serverUrl: string;
  /** What the child's HTTP clients use (HTTP_PROXY…), when it has a proxy. */
  env: Record<string, string>;
  proxy: EgressProxy | undefined;
  close(): Promise<void>;
};

/** Where the Server is: a Unix socket (ssh tunnel), a loopback port, or a remote host. */
function locate(url: string, connection: Connection) {
  if (connection.socket) return { kind: "socket" as const, path: connection.socket };
  const parsed = new URL(url);
  const port = Number(parsed.port) || DEFAULT_PORTS[parsed.protocol];
  if (!port) throw new Error(`${url}: no port to reach`);
  if (LOOPBACK.has(parsed.hostname)) return { kind: "loopback" as const, port, parsed };
  return { kind: "remote" as const, allow: `${parsed.hostname}:${port}` };
}
const proxyEnv = (
  proxyUrl: string | undefined,
  direct: string | undefined,
): Record<string, string> =>
  proxyUrl ? { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, NO_PROXY: direct ?? "" } : {};
const withPort = (parsed: URL, port: number) => {
  const url = new URL(parsed.href);
  // The child resolves no name: localhost is given as an address.
  url.hostname = "127.0.0.1";
  url.port = String(port);
  return url.href;
};

export async function confine(options: ConfineOptions): Promise<Confinement> {
  const { mechanism, granted } = options;
  const server = locate(options.server.url, options.server.connection);
  const anyHost = granted.net.includes("*");
  const needsProxy = !anyHost && (granted.net.length > 0 || server.kind === "remote");
  const allow = [...granted.net, ...(server.kind === "remote" ? [server.allow] : [])];
  const cleanup: (() => Promise<void>)[] = [];
  const close = async () => {
    for (const step of cleanup.reverse()) await step();
  };
  try {
    if (mechanism.kind === "seatbelt") {
      const proxy = needsProxy ? await startProxy({ allow, resolve: options.resolve }) : undefined;
      if (proxy) cleanup.push(() => proxy.stop());
      const route: ServerRoute =
        server.kind === "socket"
          ? { kind: "socket", path: server.path }
          : server.kind === "loopback"
            ? { kind: "loopback", port: server.port }
            : { kind: "proxy" };
      return {
        serverUrl:
          server.kind === "socket"
            ? `unix:${server.path}`
            : server.kind === "loopback"
              ? withPort(server.parsed, server.port)
              : options.server.url,
        env: proxyEnv(
          proxy && `http://127.0.0.1:${proxy.port}`,
          server.kind === "loopback" ? "127.0.0.1" : undefined,
        ),
        proxy,
        command: (tty, argv) => {
          const profile = seatbeltProfile({
            runtime: options.runtime,
            capabilities: granted,
            tmp: options.tmp,
            readable: options.readable,
            writable: options.writable,
            tty,
            server: route,
            proxyPort: proxy?.port,
          });
          options.onProfile?.(profile);
          return sandboxed(profile, argv);
        },
        close,
      };
    }
    const isolated = mechanism.kind !== "landlock" && !anyHost;
    // The Server as a target of the host: its tunnel's socket, or its loopback port.
    const target: Target | undefined =
      server.kind === "socket"
        ? { path: server.path }
        : server.kind === "loopback"
          ? { port: server.port }
          : undefined;
    let network: LinuxNetwork;
    let serverUrl = options.server.url;
    let proxyUrl: string | undefined;
    let proxy: EgressProxy | undefined;
    if (isolated) {
      // Unix sockets in a directory of the host's, which the child cannot even list.
      const sockets = realpathSync(mkdtempSync(join(tmpdir(), "luciole-relay-")));
      cleanup.push(() => Promise.resolve(rmSync(sockets, { recursive: true, force: true })));
      const relays: { port: number; socket: string }[] = [];
      if (target) {
        const toServer: Bridge = await bridge(target, join(sockets, "server.sock"));
        cleanup.push(() => toServer.close());
        relays.push({ port: RELAYED_SERVER_PORT, socket: join(sockets, "server.sock") });
        if (server.kind !== "remote")
          serverUrl =
            server.kind === "socket"
              ? `http://127.0.0.1:${RELAYED_SERVER_PORT}`
              : withPort(server.parsed, RELAYED_SERVER_PORT);
      }
      if (needsProxy) {
        proxy = await startProxy({
          allow,
          resolve: options.resolve,
          path: join(sockets, "proxy.sock"),
        });
        const started = proxy;
        cleanup.push(() => started.stop());
        relays.push({ port: RELAYED_PROXY_PORT, socket: join(sockets, "proxy.sock") });
        proxyUrl = `http://127.0.0.1:${RELAYED_PROXY_PORT}`;
      }
      network = { mode: "isolated", relays };
    } else {
      const tcp: number[] = [];
      if (target && "path" in target) {
        // The child has no Unix socket: the tunnel's socket, on a loopback port.
        const toServer = await bridge(target);
        cleanup.push(() => toServer.close());
        tcp.push(toServer.port);
        serverUrl = `http://127.0.0.1:${toServer.port}`;
      } else if (server.kind === "loopback") {
        tcp.push(server.port);
        serverUrl = withPort(server.parsed, server.port);
      }
      if (needsProxy) {
        proxy = await startProxy({ allow, resolve: options.resolve });
        const started = proxy;
        cleanup.push(() => started.stop());
        tcp.push(proxy.port);
        proxyUrl = `http://127.0.0.1:${proxy.port}`;
      }
      network = anyHost ? { mode: "open" } : { mode: "ports", tcp };
    }
    return {
      serverUrl,
      env: proxyEnv(proxyUrl, server.kind === "remote" ? undefined : "127.0.0.1"),
      proxy,
      command: (_tty, argv) => {
        const plan = {
          mechanism,
          runtime: options.runtime,
          capabilities: granted,
          tmp: options.tmp,
          readable: options.readable,
          writable: options.writable,
          network,
        };
        const command = linuxCommand(plan, argv);
        options.onProfile?.(command.join("\n"));
        return command;
      },
      close,
    };
  } catch (error: unknown) {
    await close();
    throw error;
  }
}

/** A private scratch directory for a child, removed by `remove`. */
export function scratch() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "luciole-sandbox-")));
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}
