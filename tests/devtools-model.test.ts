import { expect, test } from "bun:test";
import { fixtureSession, FIXTURE_START } from "../packages/core/src/devtools/fixtures";
import { message, PLUGIN } from "../packages/core/src/devtools/protocol";
import { parseEvent } from "../packages/core/src/devtools/schema";
import type { Stored } from "../packages/core/src/devtools/model/session";
import { toHar } from "../packages/core/src/devtools/model/har";
import { cacheBadge, phases, rowStatus } from "../packages/core/src/devtools/model/network";
import { createSession } from "../packages/core/src/devtools/model/session";

const loaded = (events = fixtureSession()) => {
  const session = createSession();
  for (const stored of events) session.add(stored);
  return session;
};
const byCall = (session: ReturnType<typeof createSession>) =>
  new Map(session.network.rows().map((row) => [row.callId ?? row.key, row]));

test("rows join Client and Server by callId, with their loader, cache and status", () => {
  const session = loaded();
  const rows = byCall(session);
  const summary = session.network.rows().map((row) => ({
    id: row.callId ?? row.source,
    cause: row.cause,
    status: rowStatus(row),
    cache: cacheBadge(row),
  }));
  expect(summary).toEqual([
    { id: "c1", cause: "navigation", status: "done", cache: "miss" },
    { id: "c2", cause: "navigation", status: "done", cache: "hit" },
    { id: "c3", cause: "action", status: "done", cache: undefined },
    { id: "router-cache", cause: "navigation", status: "cached", cache: "router" },
    { id: "router-cache", cause: "navigation", status: "cached", cache: "router" },
    { id: "c4", cause: "action", status: "done", cache: undefined },
    { id: "c5", cause: "invalidation", status: "cancelled", cache: undefined },
    { id: "c6", cause: "invalidation", status: "done", cache: "stale" },
    { id: "c7", cause: "action", status: "error", cache: undefined },
    { id: "c8", cause: "live", status: "streaming", cache: undefined },
  ]);
  const first = rows.get("c1");
  expect(first?.href).toBe("/");
  // Loader start → request → Server (40 ms of work, cache miss then write) → root model.
  expect(first && phases(first)).toMatchObject({
    queued: 2,
    server: { from: 4, to: 44 },
    ttfb: 44,
    response: 46,
  });
  expect(first?.cache.map((c) => c.op)).toEqual(["miss", "write"]);
});

test("waterfalls and double invalidations are flagged, expected sequences are not", () => {
  const session = loaded();
  const flags = session.network.derive();
  const rows = byCall(session);
  const flagged = [...flags].map(([key, flag]) => [rows.get(key)?.callId ?? key, flag]);
  expect(flagged).toEqual([
    // getComments started 5 ms after the note it belongs to finished: one after the other.
    ["c3", { waterfallAfter: "c2" }],
    // The Server's invalidate() and the component's own invalidate() after saveNote.
    ["c5", { doubleInvalidation: "action:c4" }],
    ["c6", { doubleInvalidation: "action:c4" }],
  ]);
  expect(session.network.invalidations().map((i) => [i.origin, i.cause])).toEqual([
    ["server", "action:c4"],
    ["client", "action:c4"],
  ]);
});

test("events arriving out of order build the same rows", () => {
  const events = fixtureSession();
  // The Server's events of each request before the Client's: two processes, two sockets.
  const reordered = [
    ...events.filter((e) => e.event.pluginId === "luciole-server"),
    ...events.filter((e) => e.event.pluginId !== "luciole-server"),
  ];
  const a = loaded(events)
    .network.rows()
    .map((r) => [r.key, rowStatus(r), cacheBadge(r)]);
  const b = loaded(reordered)
    .network.rows()
    .map((r) => [r.key, rowStatus(r), cacheBadge(r)]);
  expect(b).toEqual(a);
});

test("logs, cache entries, router and components", () => {
  const session = loaded();
  expect(session.sources().map((s) => [s.role, s.app])).toEqual([
    ["client", "notes"],
    ["server", "notes"],
  ]);
  expect(session.logs().map((l) => [l.role, l.level, l.callId])).toEqual([
    ["server", "log", "c2"],
    ["client", "warn", undefined],
    ["server", "error", "c7"],
  ]);
  const note = session.cache().find((e) => e.key === "getNote(1)");
  expect(note).toMatchObject({ hits: 1, stale: 1, lastOp: "stale" });
  expect(note?.invalidatedAt).toBe(FIXTURE_START + 3010);
  expect(session.tagInvalidations().map((t) => t.tags)).toEqual([["note:1"]]);
  expect(session.router()?.matches.at(-1)?.loaderData).toBe("<NotePage />");
  expect(session.components()?.nodes.find((n) => n.unnecessary)?.name).toBe("KeyHelp");
  expect(session.keys()).toHaveLength(3);
});

test("a HAR export carries timings and the luciole fields", () => {
  const session = loaded();
  const har = toHar(session.network.rows(), session.network.derive());
  expect(har.log.entries).toHaveLength(10);
  const first = har.log.entries[0];
  expect(first?.request).toMatchObject({
    method: "GET",
    url: "http://luciole.invalid/render?route=%2F&href=%2F",
  });
  expect(first?.timings).toMatchObject({ blocked: 2, wait: 44 });
  expect(first?._luciole).toMatchObject({ callId: "c1", cause: "navigation", cache: "miss" });
  expect(har.log.entries.find((e) => e._luciole.callId === "c6")?._luciole).toMatchObject({
    doubleInvalidation: "action:c4",
  });
});

test("loaders labelled `network` join their request; `router-cache` ones get their own row", () => {
  const events: Stored[] = [];
  const push = (suffix: string, payload: Record<string, unknown>) => {
    const event = parseEvent(message(PLUGIN.client, suffix, { type: suffix, ...payload }));
    if (!event) throw new Error(`invalid ${suffix}`);
    events.push({ seq: events.length + 1, source: 1, event });
  };
  const loader = { routeId: "/notes/[id]", href: "/notes/1", cause: "navigation" };
  const request = { id: 1, callId: "n1", kind: "render", target: "/notes/[id]" };
  // feat/use-cache labels every loader, network ones included.
  push("loader", { ...loader, at: 100, phase: "start", source: "network" });
  push("request", { ...request, at: 101, cause: "navigation" });
  push("response", { ...request, at: 110, status: 200, ms: 9 });
  push("end", { ...request, at: 112, ms: 11, bytes: 10, cancelled: false });
  push("loader", { ...loader, at: 113, phase: "end", ms: 13, result: "ok", source: "network" });
  // Back to the same page later: TanStack's cache answers, no request.
  push("loader", { ...loader, at: 200, phase: "end", ms: 0, result: "ok", source: "router-cache" });
  const rows = loaded(events).network.rows();
  expect(rows.map((row) => [row.key, row.source, rowStatus(row), cacheBadge(row)])).toEqual([
    ["n1", "network", "done", undefined],
    ["loader:1", "router-cache", "cached", "router"],
  ]);
  expect(rows[0]?.loader).toEqual({ start: 100, end: 113, result: "ok" });
  expect(rows[1]?.loader).toEqual({ start: 200, end: 200, result: "ok" });
});

test("a tag invalidation marks the entries carrying the tag, and creates none", () => {
  const events: Stored[] = [];
  const cache = (op: string, key: string, tags: string[], callId: string, at: number) => {
    const event = parseEvent(
      message(PLUGIN.server, "cache", {
        type: "cache",
        op,
        key,
        fn: key ? "f" : "",
        tags,
        callId,
        ms: 1,
        at,
      }),
    );
    if (!event) throw new Error("invalid cache event");
    events.push({ seq: events.length + 1, source: 2, event });
  };
  cache("write", "a", ["notes"], "c1", 1);
  cache("write", "b", ["other"], "c1", 2);
  // What `invalidate({ tag })` emits outside a request (the DevTools' Cache panel).
  cache("invalidate", "", ["notes"], "", 3);
  const session = loaded(events);
  expect(session.cache().map((e) => [e.key, e.invalidatedAt])).toEqual([
    ["a", 3],
    ["b", undefined],
  ]);
  expect(session.tagInvalidations()).toEqual([{ at: 3, tags: ["notes"], key: "" }]);
  // The invalidation belongs to no request: only the writes' request has a row.
  expect(session.network.rows().map((row) => row.callId)).toEqual(["c1"]);
});
