import { basename, dirname } from "node:path";
import type { ServerInstrument } from "../server";
// The declaration of `__LUCIOLE_SOURCES__`, filled by annotated modules.
import type {} from "./annotate";
import { appRoot, message, parseAddress, PLUGIN, PROTOCOL_VERSION } from "./protocol";
import { captureConsole, consoleText, errorStack } from "./preview";
import { parseCommand, type Command } from "./schema";
import { connectAgent } from "./wire";

/** `ServerEvent | CacheEvent`: requests and "use cache" operations alike. */
type Observed = Parameters<ServerInstrument["onEvent"]>[0];

/**
 * The Server's side of `luciole devtools`: `serve()` calls it with `LUCIOLE_DEVTOOLS`. Without
 * an address it returns `instrument` untouched, so an absent variable costs nothing.
 * With one, every `ServerEvent` (and cache event) and every console call, attributed to
 * the request it ran under, streams to the DevTools; `instrument` still receives its own.
 * Ignored in production: the DevTools are a development tool.
 */
export function devtoolsInstrument(
  instrument: ServerInstrument | undefined,
  address: string | undefined,
  context: {
    buildId: string;
    getCallId: () => string | undefined;
    /**
     * `invalidate({ tag })` of src/server.ts, handed in by `createHandler()`: imported here, it
     * would close an import cycle and load the react-server runtime with this module.
     */
    invalidateTag: (tag: string) => Promise<void>;
  },
): ServerInstrument | undefined {
  if (!address) return instrument;
  if (process.env.NODE_ENV === "production") {
    console.error("LUCIOLE_DEVTOOLS is ignored in production");
    return instrument;
  }
  const entry = process.argv[1];
  const agent = connectAgent({
    address: parseAddress(address),
    hello: {
      protocol: PROTOCOL_VERSION,
      role: "server",
      pid: process.pid,
      // `<app>/.luciole/server/index.js`, as `luciole dev` and `start` run it.
      app: entry ? basename(dirname(dirname(dirname(entry)))) : undefined,
      root: appRoot(entry),
      buildId: context.buildId,
      // Every module ran its annotations before serve() started.
      sources: Object.fromEntries(globalThis.__LUCIOLE_SOURCES__ ?? []),
    },
    onCommand: (value) => {
      const command = parseCommand(value);
      if (command) obey(command, context.invalidateTag);
    },
  });
  captureConsole((level, args) =>
    agent.send(
      message(PLUGIN.console, "entry", {
        at: performance.timeOrigin + performance.now(),
        level,
        text: consoleText(args),
        stack: errorStack(args),
        callId: context.getCallId(),
      }),
    ),
  );
  return {
    onEvent(event: Observed) {
      agent.send(message(PLUGIN.server, event.type, event));
      instrument?.onEvent(event);
    },
  };
}

/**
 * The Cache panel's invalidation: outside any request, `invalidate({ tag })` purges the
 * Server cache only (it emits `cache` `invalidate` events, callId ""); no Client is told,
 * each sees fresh data on its next render. A failure lands in the Console panel.
 */
function obey(command: Command, invalidateTag: (tag: string) => Promise<void>) {
  if (command.suffix !== "cache-invalidate") return;
  const { tag } = command.payload;
  try {
    invalidateTag(tag).catch((error: unknown) =>
      console.error(`DevTools: invalidating tag "${tag}" failed:`, error),
    );
  } catch (error) {
    console.error(`DevTools: invalid tag "${tag}":`, error);
  }
}
