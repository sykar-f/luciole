import type { ComponentNode, ConsoleLevel, DevtoolsEvent, RouterMatch } from "../schema";
import { createNetworkModel } from "./network";

/**
 * Everything the DevTools know about the inspected application, built from the events
 * their Server stored: the processes connected, the network, the Server cache, logs,
 * router state, the component tree and input. Pure and incremental: the UI feeds it
 * batches, tests feed it fixtures.
 */

/** An event as the DevTools Server stores it: in arrival order, with the process it came from. */
export type Stored = { seq: number; source: number; event: DevtoolsEvent };
/** A connected (or gone) inspected process. */
export type Source = {
  id: number;
  role?: "client" | "server";
  pid?: number;
  app?: string;
  buildId?: string;
  components?: boolean;
  connected: boolean;
};

export type LogEntry = {
  seq: number;
  at: number;
  role: "client" | "server" | "unknown";
  level: ConsoleLevel;
  text: string;
  callId?: string;
};
export type CacheEntry = {
  key: string;
  fn: string;
  tags: readonly string[];
  lastOp: string;
  lastAt: number;
  /** When the value now cached was written: its age. */
  writtenAt?: number;
  hits: number;
  misses: number;
  stale: number;
  invalidatedAt?: number;
};
export type RouterState = {
  at: number;
  status: string;
  href: string;
  resolvedHref?: string;
  matches: RouterMatch[];
  cached: RouterMatch[];
};
export type KeyPress = {
  at: number;
  name: string;
  sequence: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
};

const MAX_LOGS = 5000,
  MAX_KEYS = 200;

export function createSession() {
  const network = createNetworkModel();
  const sources = new Map<number, Source>();
  const logs: LogEntry[] = [];
  const cache = new Map<string, CacheEntry>();
  const tagInvalidations: { at: number; tags: readonly string[]; key: string }[] = [];
  const keys: KeyPress[] = [];
  let router: RouterState | undefined;
  let components: { at: number; nodes: ComponentNode[]; flashed: number[] } | undefined;
  let componentsUnavailable: string | undefined;
  let dropped = 0;
  let last = 0;

  function add({ seq, source, event }: Stored) {
    last = Math.max(last, seq);
    network.add(event);
    const from = sources.get(source);
    switch (event.type) {
      case "airtty:hello":
        // A recorded hello describes a process, not a connection: keep what is known.
        sources.set(source, { id: source, ...event.payload, connected: from?.connected ?? true });
        return;
      case "airtty:dropped":
        dropped += event.payload.count;
        return;
      case "airtty-console:entry":
        logs.push({ seq, role: from?.role ?? "unknown", ...event.payload });
        if (logs.length > MAX_LOGS) logs.shift();
        return;
      case "airtty-server:cache": {
        const p = event.payload;
        // A tag invalidation names tags, not an entry (use-cache emits `key: ""`): every
        // entry carrying one of them is gone.
        if (p.op === "invalidate" && !p.key) {
          tagInvalidations.push({ at: p.at, tags: p.tags, key: "" });
          for (const entry of cache.values())
            if (entry.tags.some((tag) => p.tags.includes(tag))) {
              entry.invalidatedAt = p.at;
              entry.lastOp = p.op;
              entry.lastAt = p.at;
            }
          return;
        }
        const entry: CacheEntry = cache.get(p.key) ?? {
          key: p.key,
          fn: p.fn,
          tags: p.tags,
          lastOp: p.op,
          lastAt: p.at,
          hits: 0,
          misses: 0,
          stale: 0,
        };
        entry.lastOp = p.op;
        entry.lastAt = p.at;
        if (p.tags.length) entry.tags = p.tags;
        if (p.op === "hit") entry.hits++;
        if (p.op === "miss") entry.misses++;
        if (p.op === "stale") entry.stale++;
        if (p.op === "write") {
          entry.writtenAt = p.at;
          entry.invalidatedAt = undefined;
        }
        if (p.op === "invalidate") {
          entry.invalidatedAt = p.at;
          tagInvalidations.push({ at: p.at, tags: p.tags, key: p.key });
        }
        cache.set(p.key, entry);
        return;
      }
      case "airtty-router:state":
        router = event.payload;
        return;
      case "airtty-components:commit":
        components = event.payload;
        componentsUnavailable = undefined;
        return;
      case "airtty-components:unavailable":
        componentsUnavailable = event.payload.reason;
        return;
      case "airtty-input:key":
        keys.push(event.payload);
        if (keys.length > MAX_KEYS) keys.shift();
        return;
      default:
        return;
    }
  }

  return {
    add,
    network,
    /** The latest event sequence seen: where a new subscription resumes. */
    last: () => last,
    setSources(next: readonly Source[]) {
      // A process reconnecting after a restart keeps its hello; one gone stays listed, greyed.
      const connected = new Set(next.map((s) => s.id));
      for (const source of sources.values()) source.connected = connected.has(source.id);
      for (const source of next) sources.set(source.id, { ...sources.get(source.id), ...source });
    },
    sources: () => [...sources.values()],
    logs: () => logs,
    cache: () => [...cache.values()].sort((a, b) => b.lastAt - a.lastAt),
    tagInvalidations: () => tagInvalidations,
    router: () => router,
    components: () => components,
    componentsUnavailable: () => componentsUnavailable,
    keys: () => keys,
    dropped: () => dropped,
    clear() {
      network.clear();
      logs.length = 0;
      cache.clear();
      tagInvalidations.length = 0;
      keys.length = 0;
      dropped = 0;
    },
  };
}
export type Session = ReturnType<typeof createSession>;
