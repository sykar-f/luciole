import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The DevTools wire protocol. A message is TanStack DevTools' event shape
 * (`@tanstack/devtools-event-client`: `{ type: "<pluginId>:<suffix>", pluginId, payload }`),
 * so their event bus can carry ours unchanged (probes/devtools-tanstack). Nothing here
 * depends on TanStack: the shape is the whole contract.
 */
export type Message = { type: string; pluginId: string; payload: unknown };

/** Bumped when a payload changes incompatibly; `hello` carries it. */
export const PROTOCOL_VERSION = 1;

/** One namespace per concern, like TanStack plugins. Suffixes are listed in schema.ts. */
export const PLUGIN = {
  /** Handshake, sent first on every connection. */
  bus: "luciole",
  /** `ApplicationEvent`s of the Client (transport, navigation, invalidate, loader). */
  client: "luciole-client",
  /** `ServerEvent`s of the Server, cache events included. */
  server: "luciole-server",
  console: "luciole-console",
  components: "luciole-components",
  router: "luciole-router",
  input: "luciole-input",
  /** Commands, from the DevTools to an inspected process. */
  control: "luciole-devtools",
} as const;
export type PluginId = (typeof PLUGIN)[keyof typeof PLUGIN];

export function message(pluginId: PluginId, suffix: string, payload: unknown): Message {
  return { type: `${pluginId}:${suffix}`, pluginId, payload };
}

/** What an inspected process says about itself, first thing on a connection. */
export type Hello = {
  protocol: number;
  role: "client" | "server";
  pid: number;
  /** The application's directory name, when the process knows it. */
  app?: string;
  buildId?: string;
  /** Whether the fiber hook was preloaded (Components panel), Client only. */
  components?: boolean;
  /** The application's directory: sources are relative to it. */
  root?: string;
  /** Server Components' sources by name (src/devtools/annotate.ts), Server only. */
  sources?: Record<string, string>;
};

/** `<root>/.luciole/<role>/index.js`, as `luciole dev` and `start` run a built process. */
export const appRoot = (entry: string | undefined) =>
  entry ? dirname(dirname(dirname(entry))) : undefined;

/**
 * Where the DevTools listen and inspected processes connect: a Unix socket (a path, or
 * `unix:` + path) or a WebSocket (`ws://host:port`). `LUCIOLE_DEVTOOLS=1` means the
 * default socket.
 */
export type Address = { kind: "unix"; path: string } | { kind: "ws"; url: string };

/**
 * Per user: `$XDG_RUNTIME_DIR` is private to its owner; macOS's `tmpdir()` is too. Elsewhere
 * the uid keeps two users' DevTools apart, and the listener makes its socket 0600.
 */
export function defaultSocketPath(env: Record<string, string | undefined> = process.env) {
  const uid = process.getuid?.() ?? 0;
  return join(env.XDG_RUNTIME_DIR ?? tmpdir(), `luciole-devtools-${uid}.sock`);
}

export function parseAddress(
  value: string,
  env: Record<string, string | undefined> = process.env,
): Address {
  if (value === "1" || value === "true") return { kind: "unix", path: defaultSocketPath(env) };
  if (value.startsWith("unix:")) return { kind: "unix", path: value.slice("unix:".length) };
  if (value.startsWith("ws://") || value.startsWith("wss://")) {
    // Throws on a malformed URL: a typo must not silently disable the DevTools.
    new URL(value);
    return { kind: "ws", url: value };
  }
  if (value.startsWith("/")) return { kind: "unix", path: value };
  throw new Error(
    `LUCIOLE_DEVTOOLS must be 1, a socket path (unix:/… or /…) or a ws:// URL, got "${value}"`,
  );
}

export const formatAddress = (address: Address) =>
  address.kind === "unix" ? address.path : address.url;
