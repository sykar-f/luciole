import "server-only";
import { readFile } from "node:fs/promises";
import * as z from "zod/mini";
import { fixtureSession } from "../../fixtures";
import type { Source, Stored } from "../../model/session";
import { formatAddress, message, parseAddress, PLUGIN } from "../../protocol";
import { parseCommand, parseEvent, type Command } from "../../schema";
import { listenBus, type Connection } from "../../wire";

/**
 * The DevTools' own Server holds the bus: inspected processes connect to it, their
 * events are stored here in arrival order, and the DevTools' Client reads them through a
 * live Server Function (actions/bus.ts). Commands go the other way. Evaluated once, when
 * the Server starts: a DevTools already listening on the same address stops this one.
 */
const Environment = z.object({
  /**
   * Set by `airtty devtools` (src/commands/devtools.ts). `none`: no bus, only a demo or
   * replayed session (the landing page's live demo, whose Server runs in a page).
   */
  AIRTTY_DEVTOOLS_LISTEN: z._default(z.string(), "1"),
  AIRTTY_DEVTOOLS_DEMO: z.optional(z.string()),
  AIRTTY_DEVTOOLS_REPLAY: z.optional(z.string()),
  /** The fiber hook to preload in the inspected Client (src/devtools/hook.ts). */
  AIRTTY_DEVTOOLS_HOOK: z.optional(z.string()),
});
const env = Environment.parse(process.env);
const MAX_EVENTS = 100_000;

let events: Stored[] = [];
let sequence = 0;
const sources = new Map<number, Source>();
const connections = new Map<number, Connection>();
const waiters = new Set<() => void>();
let rejected = 0;
const wake = () => {
  for (const waiter of waiters) waiter();
  waiters.clear();
};
function store(source: number, value: unknown) {
  const event = parseEvent(value);
  if (!event) {
    rejected++;
    return;
  }
  if (event.type === "airtty:hello")
    sources.set(source, { id: source, ...event.payload, connected: true });
  events.push({ seq: ++sequence, source, event });
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  wake();
}

const NO_BUS = "none";
const bus =
  env.AIRTTY_DEVTOOLS_LISTEN === NO_BUS
    ? undefined
    : await listenBus({
        address: parseAddress(env.AIRTTY_DEVTOOLS_LISTEN),
        onOpen(connection) {
          connections.set(connection.id, connection);
          sources.set(connection.id, { id: connection.id, connected: true });
          wake();
        },
        onMessage: (connection, value) => store(connection.id, value),
        onClose(connection) {
          connections.delete(connection.id);
          const source = sources.get(connection.id);
          if (source) source.connected = false;
          wake();
        },
      });
// Recorded or simulated sessions play under their own source ids, above any connection's.
const OFFLINE_SOURCE = 1_000_000;
// The demo session ends about now: it reads like one just recorded.
const DEMO_AGE_MS = 6000;
const Recording = z.object({
  events: z.array(z.object({ source: z.number(), event: z.unknown() })),
});
if (env.AIRTTY_DEVTOOLS_DEMO)
  for (const { source, event } of fixtureSession(Date.now() - DEMO_AGE_MS))
    store(OFFLINE_SOURCE + source, event);
if (env.AIRTTY_DEVTOOLS_REPLAY) {
  const recording = Recording.parse(JSON.parse(await readFile(env.AIRTTY_DEVTOOLS_REPLAY, "utf8")));
  for (const { source, event } of recording.events) store(OFFLINE_SOURCE + source, event);
}
for (const source of sources.values()) if (source.id >= OFFLINE_SOURCE) source.connected = false;

/**
 * What the inspected application's environment needs, shown while none is connected;
 * nothing without a bus, where nothing can connect.
 */
export const connectInfo = bus && {
  address: formatAddress(bus.address),
  hook: env.AIRTTY_DEVTOOLS_HOOK,
};

/** Events after `seq`, at most `limit`, and whether older ones were dropped meanwhile. */
export function after(seq: number, limit: number) {
  const first = events[0]?.seq ?? sequence + 1;
  const start = events.findIndex((e) => e.seq > seq);
  return {
    events: start < 0 ? [] : events.slice(start, start + limit),
    missed: seq + 1 < first && seq < sequence ? first - seq - 1 : 0,
  };
}
export const latest = () => sequence;
export const listSources = () => [...sources.values()];
export const rejectedCount = () => rejected;
/** Resolves on the next stored event or connection change, or when `signal` aborts. */
export function changed(signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    waiters.add(resolve);
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}
export function clear() {
  events = [];
  wake();
}
export function all() {
  return events;
}

/** Sends a command to every connected process of `role`; returns how many received it. */
export function send(role: "client" | "server", command: Command) {
  const outgoing = message(PLUGIN.control, command.suffix, command.payload);
  // Checked again on arrival; checked here so a bad command fails where it was made.
  if (!parseCommand(outgoing)) throw new Error(`Invalid command ${command.type}`);
  let sent = 0;
  for (const [id, connection] of connections)
    if (sources.get(id)?.role === role) {
      connection.send(outgoing);
      sent++;
    }
  return sent;
}
