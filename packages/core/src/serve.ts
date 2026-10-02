/**
 * `serve()`: the Server as a process that listens (docs/WEB.md, W2). It reads the
 * environment, refuses an exposed binding without authentication, wires the handler of
 * src/server.ts to Bun.serve on a port or a private socket, lives as long as a launcher
 * says (src/launcher/lifetime.ts), and stops on signals. The web runtime's Worker replaces
 * this module and answers the page instead (src/web/platform/serve.ts).
 */
import { chmodSync } from "node:fs";
import { z } from "zod";
import { managedLifetime } from "./launcher/lifetime";
import { createHandler, getLaunch, type AuthConfig, type ServerConfig } from "./server";
import { configuredArgs } from "./args";
import { WebOrigin, webAccess } from "./web-routes";

const DEFAULT_PORT = 3000,
  MAX_REQUEST_BYTES = 1_048_576, // 1 MiB
  IDLE_TIMEOUT_SECONDS = 30,
  PRIVATE_SOCKET = 0o600;
const ServerEnvironment = z.object({
  LUCIOLE_HOST: z.string().default("127.0.0.1"),
  LUCIOLE_TOKEN: z.string().optional(),
  LUCIOLE_USER: z.string().default("local"),
  PORT: z.coerce.number().int().min(0).default(DEFAULT_PORT),
  /** Listen on this Unix socket instead of TCP (src/launcher): replaces host and port. */
  LUCIOLE_SOCKET: z.string().min(1).optional(),
  // Test-only switches; never enabled by a request.
  LUCIOLE_TEST: z.string().optional(),
  LUCIOLE_TEST_DROP_ONCE: z.string().optional(),
  // Development only: the address of `luciole devtools` (src/devtools/server-agent.ts).
  LUCIOLE_DEVTOOLS: z.string().optional(),
  /** The one browser origin the web runtime is served to (src/web-routes.ts). */
  LUCIOLE_WEB_ORIGIN: WebOrigin.optional(),
});

export function serve(config: ServerConfig) {
  const env = ServerEnvironment.safeParse(process.env);
  if (!env.success) throw new Error(`Invalid Server environment: ${z.prettifyError(env.error)}`);
  const { LUCIOLE_HOST: hostname, LUCIOLE_TOKEN: token, LUCIOLE_SOCKET: socket } = env.data;
  const testing = env.data.LUCIOLE_TEST === "1",
    dropOnce = testing && env.data.LUCIOLE_TEST_DROP_ONCE === "1";
  // A socket is reachable by whoever may open its file: nothing binds to the network.
  if (!socket && !["127.0.0.1", "localhost", "::1"].includes(hostname) && !token && !config.auth)
    throw new Error(
      "Remote binding requires LUCIOLE_TOKEN or server/auth.ts and a TLS reverse proxy",
    );
  const auth: AuthConfig =
    config.auth ??
    ({
      authenticate(request) {
        if (token && request.headers.get("authorization") !== `Bearer ${token}`) return null;
        return { userId: env.data.LUCIOLE_USER };
      },
    } satisfies AuthConfig);
  const handler = createHandler(config, {
    auth,
    devtools: env.data.LUCIOLE_DEVTOOLS,
    testing,
    web: webAccess(config.web, env.data.LUCIOLE_WEB_ORIGIN),
    keepAlive: (req) => server.timeout(req, 0),
    dropAfterCommit: dropOnce
      ? () => {
          void server.stop(true);
          process.exit(0);
        }
      : undefined,
  });
  // Declared before `lifetime`, which stops through it; `server` exists by the time it runs.
  const shutdown = () => {
    void server.stop(true);
    process.exit(0);
  };
  // A Server the launcher manages lives as long as its Clients (src/launcher/lifetime.ts).
  const lifetime = socket
    ? managedLifetime(process.env, {
        buildId: config.buildId,
        socket,
        stop: () => shutdown(),
        args: configuredArgs()?.fingerprint,
        launch: getLaunch().id,
      })
    : undefined;
  const options = {
    maxRequestBodySize: MAX_REQUEST_BYTES,
    fetch(req: Request) {
      const url = new URL(req.url);
      return lifetime?.handle(req, url) ?? handler(req, url);
    },
  };
  // On a socket Bun's default idle timeout (10 s) would cut a slow page, action or live
  // stream, and it ignores `server.timeout(req, 0)` there (tests/socket-timeout.test.ts):
  // the timeout is disabled. The socket is private to its user, so there is no stranger's
  // idle connection to shed; the Client's own request timeout still applies. Bun's types
  // refuse idleTimeout next to `unix` though it honors it: set outside the literal.
  const unix = { ...options, unix: socket ?? "" };
  Object.assign(unix, { idleTimeout: 0 });
  const server = socket
    ? Bun.serve(unix)
    : Bun.serve({ ...options, hostname, port: env.data.PORT, idleTimeout: IDLE_TIMEOUT_SECONDS });
  // Bun creates the socket 0755; Linux checks write access on connect. Its directory
  // should be private too: macOS ignores a socket's own mode.
  if (socket) chmodSync(socket, PRIVATE_SOCKET);
  console.log(
    JSON.stringify({
      ready: true,
      ...(socket ? { socket } : { port: server.port }),
      pid: process.pid,
      buildId: config.buildId,
    }),
  );
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  return server;
}
