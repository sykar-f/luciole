/**
 * Can TanStack DevTools' event bus carry airtty's DevTools protocol, so a future web front
 * could reuse their shell? Runs their real `ServerEventBus` (the one their Vite plugin
 * starts) in this process, bridges airtty messages onto it the way their `EventClient`
 * does, and plays their browser shell with a WebSocket and an SSE reader. See README.md.
 */
import { ServerEventBus } from "@tanstack/devtools-event-bus/server";
import { EventClient } from "@tanstack/devtools-event-client";
import { fixtureSession } from "../../packages/airtty/src/devtools/fixtures";
import { message, PLUGIN, type Message } from "../../packages/airtty/src/devtools/protocol";
import { parseCommand, parseEvent } from "../../packages/airtty/src/devtools/schema";
import { encode } from "../../packages/airtty/src/devtools/wire";

const POLL_MS = 10,
  SETTLE_MS = 50;
const assert = (condition: unknown, what: string) => {
  if (!condition) throw new Error(`Probe failed: ${what}`);
};
const until = async (check: () => boolean, what: string, ms = 3000) => {
  const deadline = performance.now() + ms;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`Probe timed out: ${what}`);
    await Bun.sleep(POLL_MS);
  }
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

// Their bus only starts in development, like their Vite plugin.
process.env.NODE_ENV = "development";
const bus = new ServerEventBus({ port: 0, host: "127.0.0.1" });
const port = await bus.start();
const target = globalThis.__TANSTACK_EVENT_TARGET__;
assert(target, "the bus installs its global event target");

/**
 * The bridge airtty's DevTools Server would run: every stored message is dispatched as
 * `tanstack-dispatch-event` (what `EventClient.emit` does), commands come back as events on
 * the same target. `source`, the inspected process, rides as an extra top-level field.
 */
const commands: unknown[] = [];
const forward = (outgoing: Message & { source?: number }) =>
  target?.dispatchEvent(new CustomEvent("tanstack-dispatch-event", { detail: outgoing }));
target?.addEventListener("tanstack-devtools-global", (event) => {
  const detail: unknown = event instanceof CustomEvent ? event.detail : undefined;
  if (isRecord(detail) && detail.pluginId === PLUGIN.control) commands.push(detail);
});

// Their browser shell: a WebSocket on /__devtools/ws, and the SSE fallback.
const shell: unknown[] = [];
const socket = new WebSocket(`ws://127.0.0.1:${port}/__devtools/ws`);
socket.onmessage = (event: MessageEvent<unknown>) => shell.push(JSON.parse(String(event.data)));
await new Promise((open) => (socket.onopen = open));
const sse: string[] = [];
const stream = await fetch(`http://127.0.0.1:${port}/__devtools/sse`);
void (async () => {
  const decoder = new TextDecoder();
  for await (const chunk of stream.body ?? []) sse.push(decoder.decode(chunk));
})();
await Bun.sleep(SETTLE_MS);

const session = fixtureSession();
const bridged = (stored: (typeof session)[number]): Message & { source: number } => ({
  ...stored.event,
  source: stored.source,
});
const t0 = performance.now();
for (const stored of session) forward(bridged(stored));
await until(() => shell.length === session.length, "every airtty event reaches the shell");
const deliveryMs = performance.now() - t0;
const intact = session.every((stored, i) => {
  const received = shell[i];
  return JSON.stringify(received) === encode(bridged(stored)) && parseEvent(received) !== undefined;
});
assert(intact, "events arrive unchanged, in order, and still parse as airtty events");
await until(
  () => sse.join("").split("data: ").length - 1 >= session.length,
  "the SSE fallback carries them too",
);

// Their own EventClient, with an airtty plugin id, emits exactly an airtty message.
const client = new EventClient({ pluginId: PLUGIN.client, reconnectEveryMs: POLL_MS });
const payload = {
  type: "request",
  id: 1,
  callId: "probe",
  at: Date.now(),
  kind: "render",
  target: "/",
  cause: "navigation",
};
const before = shell.length;
client.emit("request", payload);
await until(() => shell.length > before, "EventClient reaches the shell");
const emitted = shell.at(-1);
// Same fields and values; only their key order differs (`type, payload, pluginId`).
assert(
  Bun.deepEquals(emitted, message(PLUGIN.client, "request", payload)),
  "EventClient's message is airtty's message",
);

// Commands, from the shell back to the application: a TanStack plugin can listen too.
const listened: unknown[] = [];
new EventClient({ pluginId: PLUGIN.control }).on("invalidate", (event) => listened.push(event));
socket.send(JSON.stringify(message(PLUGIN.control, "invalidate", { paths: ["/notes"] })));
await until(() => commands.length === 1 && listened.length === 1, "a command reaches the bridge");
assert(parseCommand(commands[0])?.suffix === "invalidate", "the command parses as airtty's");

// BigInt: TanStack encodes { __type: "bigint", value }, airtty a string. No payload has one.
const bigint = encode(message(PLUGIN.client, "x", { n: 1n }));

socket.close();
bus.stop();
const results = {
  date: new Date().toISOString().slice(0, "YYYY-MM-DD".length),
  bus: "@tanstack/devtools-event-bus 0.4.3 (ServerEventBus), @tanstack/devtools-event-client 0.4.4",
  eventsBridged: session.length,
  deliveredUnchangedInOrder: intact,
  sseFallback: true,
  eventClientShapeIdentical: true,
  commandsBackToBridge: true,
  tanstackPluginReceivesCommands: listened.length === 1,
  extraTopLevelFieldsSurvive: true,
  bigintEncodingDiffers: bigint.includes('"n":"1"'),
  deliveryMs: Math.round(deliveryMs),
};
await Bun.write(new URL("results.json", import.meta.url), JSON.stringify(results, null, 2) + "\n");
console.log(results);
process.exit(0);
