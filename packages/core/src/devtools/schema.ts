import * as z from "zod/mini";
import { PLUGIN } from "./protocol";

/**
 * Every message the DevTools understand, checked on arrival: inspected processes are
 * other programs, possibly of another framework version. Payloads are loose objects,
 * so a field added later (feat/use-cache's `source`, for instance) reaches the UI's
 * detail view instead of being stripped.
 */

const at = z.number();
const transport = {
  id: z.number(),
  callId: z.string(),
  at,
  kind: z.enum(["render", "action"]),
  target: z.string(),
};
const Outcome = z.enum(["not-sent", "rejected", "unknown"]);
/** `ApplicationEvent` (src/client.tsx), one schema per `type`. */
const client = {
  request: z.looseObject({ ...transport, type: z.literal("request"), cause: z.string() }),
  response: z.looseObject({
    ...transport,
    type: z.literal("response"),
    status: z.number(),
    ms: z.number(),
  }),
  chunk: z.looseObject({ ...transport, type: z.literal("chunk"), bytes: z.number() }),
  end: z.looseObject({
    ...transport,
    type: z.literal("end"),
    ms: z.number(),
    bytes: z.number(),
    cancelled: z.boolean(),
  }),
  error: z.looseObject({
    ...transport,
    type: z.literal("error"),
    ms: z.number(),
    outcome: Outcome,
    message: z.string(),
  }),
  navigation: z.looseObject({ type: z.literal("navigation"), at, path: z.string() }),
  invalidate: z.looseObject({
    type: z.literal("invalidate"),
    at,
    paths: z.array(z.string()),
    origin: z.enum(["server", "client"]),
  }),
  loader: z.looseObject({
    type: z.literal("loader"),
    at,
    phase: z.enum(["start", "end"]),
    routeId: z.string(),
    href: z.string(),
    cause: z.string(),
    ms: z.optional(z.number()),
    result: z.optional(z.enum(["ok", "error", "aborted"])),
    /**
     * `router-cache`: answered by TanStack's cache, no request (Chrome's "memory cache").
     * Emitted by feat/use-cache, or synthesized by the DevTools agent (`synthetic`).
     */
    source: z.optional(z.string()),
    synthetic: z.optional(z.boolean()),
  }),
};
const serverBase = {
  callId: z.string(),
  at,
  kind: z.enum(["render", "action"]),
  target: z.string(),
};
/** `ServerEvent` and `CacheEvent` (src/server.ts, src/cache/runtime.ts). */
const server = {
  request: z.looseObject({ ...serverBase, type: z.literal("request") }),
  response: z.looseObject({
    ...serverBase,
    type: z.literal("response"),
    status: z.number(),
    ms: z.number(),
  }),
  end: z.looseObject({
    ...serverBase,
    type: z.literal("end"),
    ms: z.number(),
    bytes: z.number(),
    cancelled: z.boolean(),
  }),
  error: z.looseObject({
    ...serverBase,
    type: z.literal("error"),
    ms: z.number(),
    message: z.string(),
  }),
  cache: z.looseObject({
    type: z.literal("cache"),
    op: z.enum(["hit", "miss", "stale", "write", "invalidate"]),
    key: z.string(),
    fn: z.string(),
    tags: z.array(z.string()),
    callId: z.optional(z.string()),
    ms: z.optional(z.number()),
    at,
  }),
};
export const ConsoleLevel = z.enum(["log", "info", "warn", "error", "debug"]);
const Rect = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
/** One component instance of a commit, flattened in tree order (`parent` links them). */
const ComponentNode = z.object({
  id: z.number(),
  parent: z.nullable(z.number()),
  depth: z.number(),
  name: z.string(),
  /** `server`: a Server Component, known from Flight's `_debugInfo` (development builds). */
  kind: z.enum(["client", "server", "host"]),
  key: z.optional(z.string()),
  env: z.optional(z.string()),
  /** Where it is defined, `file:line` relative to the application (src/build-names.ts). */
  source: z.optional(z.string()),
  /** The absolute file to open, when it lies outside the application (the framework). */
  file: z.optional(z.string()),
  renders: z.number(),
  /** When it last rendered, epoch ms. */
  renderedAt: z.optional(z.number()),
  /** Why it last rendered: `mount`, `props: a, b`, `state`, `context`, `parent`. */
  reason: z.optional(z.string()),
  /** Rendered with equal props, state and context: only because its parent did. */
  unnecessary: z.optional(z.boolean()),
  props: z.optional(z.record(z.string(), z.string())),
  hooks: z.optional(z.array(z.string())),
  rect: z.optional(Rect),
});
const RouterMatch = z.looseObject({
  id: z.string(),
  routeId: z.string(),
  pathname: z.string(),
  status: z.string(),
  isFetching: z.union([z.boolean(), z.string()]),
  invalid: z.optional(z.boolean()),
  preload: z.optional(z.boolean()),
  updatedAt: z.optional(z.number()),
  params: z.optional(z.record(z.string(), z.unknown())),
  search: z.optional(z.record(z.string(), z.unknown())),
  /** A short description of the loader's value (a Flight tree: its root element). */
  loaderData: z.optional(z.string()),
  error: z.optional(z.string()),
});
export const Hello = z.object({
  protocol: z.number(),
  role: z.enum(["client", "server"]),
  pid: z.number(),
  app: z.optional(z.string()),
  buildId: z.optional(z.string()),
  components: z.optional(z.boolean()),
  /** The application's directory, to open a component's source in an editor. */
  root: z.optional(z.string()),
  /** Server Components' sources by name: Flight carries their name only. */
  sources: z.optional(z.record(z.string(), z.string())),
});
const payloads = {
  [PLUGIN.bus]: { hello: Hello, dropped: z.object({ count: z.number() }) },
  [PLUGIN.client]: client,
  [PLUGIN.server]: server,
  [PLUGIN.console]: {
    entry: z.object({
      at,
      level: ConsoleLevel,
      text: z.string(),
      /** The Server request the log was written under (`getCallId()`). */
      callId: z.optional(z.string()),
      stack: z.optional(z.string()),
    }),
  },
  [PLUGIN.components]: {
    commit: z.object({ at, nodes: z.array(ComponentNode), flashed: z.array(z.number()) }),
    unavailable: z.object({ reason: z.string() }),
  },
  [PLUGIN.router]: {
    state: z.object({
      at,
      status: z.string(),
      href: z.string(),
      resolvedHref: z.optional(z.string()),
      matches: z.array(RouterMatch),
      cached: z.array(RouterMatch),
    }),
  },
  [PLUGIN.input]: {
    key: z.object({
      at,
      name: z.string(),
      sequence: z.string(),
      ctrl: z.boolean(),
      meta: z.boolean(),
      shift: z.boolean(),
    }),
  },
} as const;
type Payloads = typeof payloads;
type Variant<
  P extends keyof Payloads,
  S extends keyof Payloads[P],
> = Payloads[P][S] extends z.ZodMiniType
  ? { type: `${P}:${S & string}`; pluginId: P; payload: z.infer<Payloads[P][S]> }
  : never;
type Variants<P extends keyof Payloads> = {
  [S in keyof Payloads[P]]: Variant<P, S>;
}[keyof Payloads[P]];
/** Every event the DevTools understand, discriminated by its full `type`. */
export type DevtoolsEvent = { [P in keyof Payloads]: Variants<P> }[keyof Payloads];
export type ComponentNode = z.infer<typeof ComponentNode>;
export type RouterMatch = z.infer<typeof RouterMatch>;
export type ConsoleLevel = z.infer<typeof ConsoleLevel>;

const Envelope = z.object({ type: z.string(), pluginId: z.string(), payload: z.unknown() });
const isPlugin = (id: string): id is keyof Payloads => Object.hasOwn(payloads, id);
const schemaOf = (pluginId: string, suffix: string): z.ZodMiniType | undefined => {
  if (!isPlugin(pluginId)) return undefined;
  const table: Record<string, z.ZodMiniType> = payloads[pluginId];
  return Object.hasOwn(table, suffix) ? table[suffix] : undefined;
};
const isEvent = (value: { type: string; pluginId: string }): value is DevtoolsEvent =>
  schemaOf(value.pluginId, value.type.slice(value.pluginId.length + 1)) !== undefined;

/**
 * A message from an inspected process, checked; `undefined` when it is malformed, of an
 * unknown type, or its payload does not match (a newer or older inspected process).
 */
export function parseEvent(value: unknown): DevtoolsEvent | undefined {
  const envelope = Envelope.safeParse(value);
  if (!envelope.success) return undefined;
  const { type, pluginId } = envelope.data;
  if (!type.startsWith(`${pluginId}:`)) return undefined;
  const schema = schemaOf(pluginId, type.slice(pluginId.length + 1));
  const payload = schema?.safeParse(envelope.data.payload);
  if (!payload?.success) return undefined;
  const event = { type, pluginId, payload: payload.data };
  return isEvent(event) ? event : undefined;
}

/** Commands the DevTools send an inspected process (`luciole-devtools:<suffix>`). */
const Fault = z.object({ type: z.enum(["refuse", "drop", "cut"]), p: z.number() });
export const NetworkControl = z.object({
  /** Added before each request is sent, on top of `LUCIOLE_LATENCY_MS`. */
  latencyMs: z.optional(z.number().check(z.gte(0))),
  jitterMs: z.optional(z.number().check(z.gte(0))),
  chunkDelayMs: z.optional(z.number().check(z.gte(0))),
  faults: z.optional(z.array(Fault)),
});
export type NetworkControl = z.infer<typeof NetworkControl>;
const commands = {
  invalidate: z.object({ paths: z.optional(z.array(z.string())) }),
  refresh: z.object({}),
  network: NetworkControl,
  highlight: z.object({ enabled: z.boolean(), unnecessaryOnly: z.optional(z.boolean()) }),
  select: z.object({ id: z.nullable(z.number()) }),
  snapshot: z.object({}),
  /** To the Server: purge the "use cache" results labelled `tag` (no Client is told). */
  "cache-invalidate": z.object({ tag: z.string() }),
};
type Commands = typeof commands;
export type Command = {
  [S in keyof Commands]: {
    type: `luciole-devtools:${S}`;
    suffix: S;
    payload: z.infer<Commands[S]>;
  };
}[keyof Commands];
const isCommandSuffix = (suffix: string): suffix is keyof Commands =>
  Object.hasOwn(commands, suffix);
const commandOf = <S extends keyof Commands>(suffix: S, payload: unknown): Command | undefined => {
  const parsed = commands[suffix].safeParse(payload);
  if (!parsed.success) return undefined;
  const command = { type: `luciole-devtools:${suffix}`, suffix, payload: parsed.data };
  return isCommand(command) ? command : undefined;
};
const isCommand = (value: { suffix: string }): value is Command => isCommandSuffix(value.suffix);

/** A command received by an inspected process, checked; `undefined` otherwise. */
export function parseCommand(value: unknown): Command | undefined {
  const envelope = Envelope.safeParse(value);
  if (!envelope.success || envelope.data.pluginId !== PLUGIN.control) return undefined;
  const suffix = envelope.data.type.slice(PLUGIN.control.length + 1);
  return isCommandSuffix(suffix) ? commandOf(suffix, envelope.data.payload) : undefined;
}
