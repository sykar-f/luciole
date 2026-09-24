import type { DevtoolsEvent } from "../schema";

/**
 * The Network panel's model: one row per request, Client and Server sides joined by
 * `callId`, with the page loader that caused it, the Server cache operations it did,
 * and the rows TanStack answered from its cache without any request. Built
 * incrementally (events arrive out of order across the two processes: a Server event
 * may precede the Client's own `request`); `derive()` then flags sequential waterfalls
 * and double invalidations over the whole set.
 */
export type CacheOp = {
  op: string;
  key: string;
  fn: string;
  tags: readonly string[];
  at: number;
  ms?: number;
};
export type Row = {
  key: string;
  callId?: string;
  kind: "render" | "action";
  target: string;
  cause: string;
  href?: string;
  /** `router-cache`: served by TanStack's cache, no request ("(memory cache)"). */
  source: string;
  loader?: { start?: number; end?: number; result?: string };
  client: {
    request?: number;
    response?: number;
    status?: number;
    chunks: { at: number; bytes: number }[];
    end?: number;
    bytes: number;
    cancelled?: boolean;
    error?: { at: number; outcome: string; message: string };
  };
  server: {
    request?: number;
    response?: number;
    status?: number;
    end?: number;
    bytes?: number;
    error?: { at: number; message: string };
  };
  cache: CacheOp[];
  /** The invalidation this render answers (`Invalidation.cause`), when it does. */
  invalidatedBy?: string;
};
export type Invalidation = {
  at: number;
  paths: readonly string[];
  origin: "server" | "client";
  /** The action it follows (`action:<callId>`), or itself: invalidations sharing one are one cause. */
  cause: string;
};
export type Flags = {
  /** The row this one started right after, sequentially (`Row.key`). */
  waterfallAfter?: string;
  /** Rendered again for the same cause: the cause's key. */
  doubleInvalidation?: string;
};
export type CacheBadge = "router" | "hit" | "miss" | "stale" | "partial" | undefined;

/** A Server cache answer this long after an action is part of it; so is an invalidation. */
const SAME_CAUSE_MS = 250;
/** A request starting this soon after another ended most likely waited for it. */
const WATERFALL_GAP_MS = 25;
const INVALIDATING = new Set(["invalidation", "refresh"]);

export const rowStart = (row: Row) =>
  row.loader?.start ?? row.client.request ?? row.server.request ?? row.loader?.end ?? 0;
export const rowEnd = (row: Row) =>
  row.client.error?.at ??
  row.client.end ??
  row.server.error?.at ??
  row.server.end ??
  row.loader?.end;
/**
 * When the caller had its answer: the root model for a render, the result for an action.
 * A cancelled request answered nothing: what follows it is a restart, not a waterfall.
 */
const answered = (row: Row) =>
  row.client.cancelled || row.client.error ? undefined : (row.client.end ?? row.client.response);
export const rowStatus = (row: Row) =>
  row.client.error || row.server.error
    ? "error"
    : row.client.cancelled
      ? "cancelled"
      : row.loader?.result === "aborted"
        ? "aborted"
        : row.source === "router-cache"
          ? "cached"
          : rowEnd(row) === undefined
            ? row.client.response === undefined
              ? "pending"
              : "streaming"
            : "done";

export function cacheBadge(row: Row): CacheBadge {
  if (row.source === "router-cache") return "router";
  const reads = row.cache.filter((c) => c.op === "hit" || c.op === "miss" || c.op === "stale");
  if (!reads.length) return undefined;
  const hits = reads.filter((c) => c.op === "hit").length;
  if (reads.some((c) => c.op === "stale")) return "stale";
  return hits === reads.length ? "hit" : hits ? "partial" : "miss";
}

type LoaderStart = {
  at: number;
  routeId: string;
  href: string;
  cause: string;
  row?: string;
  ended?: boolean;
};

export function createNetworkModel() {
  const rows = new Map<string, Row>();
  const invalidations: Invalidation[] = [];
  const loaders: LoaderStart[] = [];
  let sequence = 0;
  let derived: Map<string, Flags> | undefined;
  const rowFor = (callId: string, kind: Row["kind"], target: string): Row => {
    const known = rows.get(callId);
    if (known) {
      // A cache event may have created it before anything named its request.
      if (!known.target && target) Object.assign(known, { kind, target });
      return known;
    }
    const row: Row = {
      key: callId,
      callId,
      kind,
      target,
      cause: "unknown",
      source: "network",
      client: { chunks: [], bytes: 0 },
      server: {},
      cache: [],
    };
    rows.set(callId, row);
    return row;
  };
  // The action whose answer came just before `at`: invalidations right after it are its own.
  const causeAt = (at: number, fallback: string) => {
    let best: Row | undefined;
    for (const row of rows.values()) {
      const done = row.kind === "action" ? (row.client.response ?? row.client.end) : undefined;
      if (done === undefined || done > at || at - done > SAME_CAUSE_MS) continue;
      if (!best || done > (best.client.response ?? 0)) best = row;
    }
    return best?.callId ? `action:${best.callId}` : fallback;
  };

  function add(event: DevtoolsEvent) {
    derived = undefined;
    switch (event.type) {
      case "airtty-client:request": {
        const p = event.payload;
        const row = rowFor(p.callId, p.kind, p.target);
        row.client.request = p.at;
        row.cause = p.cause;
        // The loader that asked for this render: same route and cause, not yet served.
        if (p.kind === "render") {
          const loader = loaders.find(
            (l) => !l.row && l.routeId === p.target && l.cause === p.cause && l.at <= p.at,
          );
          if (loader) {
            loader.row = row.key;
            row.href = loader.href;
            row.loader = { ...row.loader, start: loader.at };
          }
          if (INVALIDATING.has(p.cause))
            row.invalidatedBy = invalidations.findLast(
              (i) => i.at <= (row.loader?.start ?? p.at),
            )?.cause;
        }
        return;
      }
      case "airtty-client:response": {
        const p = event.payload;
        const row = rowFor(p.callId, p.kind, p.target);
        row.client.response = p.at;
        row.client.status = p.status;
        return;
      }
      case "airtty-client:chunk": {
        const p = event.payload;
        const row = rowFor(p.callId, p.kind, p.target);
        row.client.chunks.push({ at: p.at, bytes: p.bytes });
        row.client.bytes += p.bytes;
        return;
      }
      case "airtty-client:end": {
        const p = event.payload;
        const row = rowFor(p.callId, p.kind, p.target);
        row.client.end = p.at;
        row.client.cancelled = p.cancelled;
        return;
      }
      case "airtty-client:error": {
        const p = event.payload;
        rowFor(p.callId, p.kind, p.target).client.error = {
          at: p.at,
          outcome: p.outcome,
          message: p.message,
        };
        return;
      }
      case "airtty-client:invalidate": {
        const p = event.payload;
        invalidations.push({
          at: p.at,
          paths: p.paths,
          origin: p.origin,
          cause: causeAt(p.at, `invalidate:${invalidations.length}`),
        });
        return;
      }
      case "airtty-client:loader": {
        const p = event.payload;
        if (p.phase === "start") {
          loaders.push({ at: p.at, routeId: p.routeId, href: p.href, cause: p.cause });
          return;
        }
        // Every loader says where its answer came from (feat/use-cache: `network` or
        // `router-cache`; absent from older Clients, which means `network`). The router's
        // cache answers without a request: its own row, never the one of an earlier load
        // of the same page.
        const cached = p.source === "router-cache";
        const started = cached
          ? undefined
          : loaders.findLast(
              (l) =>
                !l.ended && l.routeId === p.routeId && l.href === p.href && l.cause === p.cause,
            );
        if (started) started.ended = true;
        const linked = started?.row ? rows.get(started.row) : undefined;
        if (linked) {
          linked.loader = { ...linked.loader, end: p.at, result: p.result };
          return;
        }
        // No request behind this loader: the router's cache, a transport decorator's
        // answer, or a load aborted before sending. It still gets its row.
        const key = `loader:${++sequence}`;
        if (started) started.row = key;
        rows.set(key, {
          key,
          kind: "render",
          target: p.routeId,
          cause: p.cause,
          href: p.href,
          source: cached ? "router-cache" : p.result === "aborted" ? "aborted" : "no-request",
          loader: { start: started?.at ?? p.at, end: p.at, result: p.result },
          client: { chunks: [], bytes: 0 },
          server: {},
          cache: [],
        });
        return;
      }
      case "airtty-server:request":
      case "airtty-server:response":
      case "airtty-server:end":
      case "airtty-server:error": {
        const p = event.payload;
        const row = rowFor(p.callId, p.kind, p.target);
        if (p.type === "request") row.server.request = p.at;
        else if (p.type === "response") {
          row.server.response = p.at;
          row.server.status = p.status;
        } else if (p.type === "end") {
          row.server.end = p.at;
          row.server.bytes = p.bytes;
        } else row.server.error = { at: p.at, message: p.message };
        return;
      }
      case "airtty-server:cache": {
        const p = event.payload;
        if (!p.callId) return;
        const row = rows.get(p.callId) ?? rowFor(p.callId, "render", "");
        row.cache.push({ op: p.op, key: p.key, fn: p.fn, tags: p.tags, at: p.at, ms: p.ms });
        return;
      }
      default:
        return;
    }
  }

  /** Waterfalls and double invalidations, over every row. Cached until the next `add`. */
  function derive(): Map<string, Flags> {
    if (derived) return derived;
    const flags = new Map<string, Flags>();
    const set = (key: string, flag: Flags) => flags.set(key, { ...flags.get(key), ...flag });
    const sent = [...rows.values()].filter(
      (row) => row.source === "network" && row.client.request !== undefined,
    );
    for (const row of sent) {
      if (row.cause === "preload" || row.cause === "live") continue;
      const start = row.client.request ?? 0;
      // What it may have waited for: a request answered just before it started, and the
      // action it re-renders for is expected, not a waterfall (its cause shows the link).
      const before = sent.find((other) => {
        const done = answered(other);
        return (
          other !== row &&
          done !== undefined &&
          (other.client.request ?? 0) < start &&
          start >= done &&
          start - done <= WATERFALL_GAP_MS &&
          row.invalidatedBy !== `action:${other.callId}`
        );
      });
      if (before) set(row.key, { waterfallAfter: before.key });
    }
    const groups = new Map<string, Row[]>();
    for (const row of rows.values()) {
      if (!row.invalidatedBy || row.kind !== "render") continue;
      const key = `${row.invalidatedBy}\n${row.target}\n${row.href ?? ""}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    for (const group of groups.values())
      if (group.length > 1)
        for (const row of group) set(row.key, { doubleInvalidation: row.invalidatedBy });
    derived = flags;
    return flags;
  }

  return {
    add,
    derive,
    /** Rows by start time. */
    rows: () => [...rows.values()].sort((a, b) => rowStart(a) - rowStart(b)),
    invalidations: () => invalidations,
    clear() {
      rows.clear();
      invalidations.length = 0;
      loaders.length = 0;
      derived = undefined;
    },
  };
}
export type NetworkModel = ReturnType<typeof createNetworkModel>;

/** The phases of a row, as offsets from its start, for the Gantt bar. */
export function phases(row: Row) {
  const start = rowStart(row);
  const request = row.client.request;
  const response = row.client.response;
  const end = rowEnd(row);
  const offset = (at: number | undefined) => (at === undefined ? undefined : at - start);
  return {
    /** Before the request left: the loader's wait, added latency included. */
    queued: request === undefined ? undefined : request - start,
    /** From sending to the Server's headers, when the Server reported them. */
    server:
      row.server.request === undefined
        ? undefined
        : { from: row.server.request - start, to: offset(row.server.response ?? row.server.end) },
    ttfb: request !== undefined && response !== undefined ? response - request : undefined,
    response: offset(response),
    end: offset(end),
    chunks: row.client.chunks.map((c) => c.at - start),
  };
}
