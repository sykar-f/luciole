/**
 * A Server confined like a sandboxed Client (docs/EMBEDDING.md, section 5), for a host
 * that runs a Server whose code it does not trust: studio's preview, where a model wrote
 * the pages and Server Functions. The same generated profile, plus the right to listen on
 * one loopback port the host chose; no terminal; `net` through the host's egress proxy.
 * Measured by probes/studio-server-sandbox.
 *
 * macOS (Seatbelt) only for now: under airtty-sandbox the Server would listen inside its
 * network namespace and the host reach it through a reverse relay, not built yet. Other
 * mechanisms are refused, never simulated.
 */
import { createServer } from "node:net";
import type { Capabilities } from "../capabilities";
import { scratch } from "./confine";
import type { Mechanism } from "./mechanism";
import { sandboxed, seatbeltProfile, type SandboxRuntime } from "./profile";
import { startProxy, type EgressProxy } from "./proxy";

export type ServerSandboxOptions = {
  mechanism: Mechanism;
  runtime: SandboxRuntime;
  granted: Capabilities;
  /** What the Server reads: its build (`.airtty/`), its `package.json`. */
  readable: readonly string[];
  /** Where it writes: its data directory. */
  writable: readonly string[];
  /** Tests: maps a proxied name to the address actually dialled. */
  resolve?: (host: string) => string;
  /** Tests: sees the profile generated. */
  onProfile?: (profile: string) => void;
};
export type ServerSandbox = {
  /** The loopback port the Server may listen on (its `PORT`). */
  port: number;
  /** The Server's whole environment: `PORT`, a private `HOME`/`TMPDIR`, the proxy. */
  env: Record<string, string>;
  /** argv running `argv` confined. */
  command: (argv: readonly string[]) => string[];
  proxy: EgressProxy | undefined;
  close(): Promise<void>;
};

/** A loopback port free now; the Server takes it right after (a short race, retried by the host). */
export async function freeLoopbackPort() {
  const probe = createServer().listen(0, "127.0.0.1");
  await new Promise((done) => probe.once("listening", done));
  const address = probe.address();
  await new Promise((done) => probe.close(done));
  if (typeof address !== "object" || !address) throw new Error("No loopback port available");
  return address.port;
}

export async function confineServer(options: ServerSandboxOptions): Promise<ServerSandbox> {
  const { mechanism, granted } = options;
  if (mechanism.kind !== "seatbelt")
    throw new Error(
      `A confined Server needs Seatbelt (macOS) for now; ${mechanism.kind} cannot confine a Server that listens yet`,
    );
  const tmp = scratch();
  let proxy: EgressProxy | undefined;
  try {
    const hosts = granted.net.filter((host) => host !== "*");
    if (!granted.net.includes("*") && hosts.length)
      proxy = await startProxy({ allow: hosts, resolve: options.resolve });
    const port = await freeLoopbackPort();
    const proxyUrl = proxy && `http://127.0.0.1:${proxy.port}`;
    const profile = seatbeltProfile({
      runtime: options.runtime,
      capabilities: granted,
      tmp: tmp.path,
      readable: options.readable,
      writable: options.writable,
      server: { kind: "none" },
      listen: port,
      proxyPort: proxy?.port,
    });
    options.onProfile?.(profile);
    const started = proxy;
    return {
      port,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: tmp.path,
        TMPDIR: tmp.path,
        PORT: String(port),
        AIRTTY_HOST: "127.0.0.1",
        // Nothing to cache: the Server could not write it anyway.
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        ...(proxyUrl && { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, NO_PROXY: "127.0.0.1" }),
      },
      command: (argv) => sandboxed(profile, argv),
      proxy,
      close: async () => {
        await started?.stop();
        tmp.remove();
      },
    };
  } catch (error: unknown) {
    await proxy?.stop();
    tmp.remove();
    throw error;
  }
}
