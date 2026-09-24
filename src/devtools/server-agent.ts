import { basename, dirname } from "node:path";
import type { ServerInstrument } from "../server";
import { message, parseAddress, PLUGIN, PROTOCOL_VERSION } from "./protocol";
import { captureConsole, consoleText } from "./preview";
import { connectAgent } from "./wire";

/** `ServerEvent | CacheEvent`: requests and "use cache" operations alike. */
type Observed = Parameters<ServerInstrument["onEvent"]>[0];

/**
 * The Server's side of `airtty devtools`: `serve()` calls it with `AIRTTY_DEVTOOLS`. Without
 * an address it returns `instrument` untouched, so an absent variable costs nothing.
 * With one, every `ServerEvent` (and cache event) and every console call, attributed to
 * the request it ran under, streams to the DevTools; `instrument` still receives its own.
 * Ignored in production: the DevTools are a development tool.
 */
export function devtoolsInstrument(
  instrument: ServerInstrument | undefined,
  address: string | undefined,
  context: { buildId: string; getCallId: () => string | undefined },
): ServerInstrument | undefined {
  if (!address) return instrument;
  if (process.env.NODE_ENV === "production") {
    console.error("AIRTTY_DEVTOOLS is ignored in production");
    return instrument;
  }
  const entry = process.argv[1];
  const agent = connectAgent({
    address: parseAddress(address),
    hello: {
      protocol: PROTOCOL_VERSION,
      role: "server",
      pid: process.pid,
      // `<app>/.airtty/server/index.js`, as `airtty dev` and `start` run it.
      app: entry ? basename(dirname(dirname(dirname(entry)))) : undefined,
      buildId: context.buildId,
    },
  });
  captureConsole((level, args) =>
    agent.send(
      message(PLUGIN.console, "entry", {
        at: performance.timeOrigin + performance.now(),
        level,
        text: consoleText(args),
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
