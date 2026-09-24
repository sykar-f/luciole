import { expect, test } from "bun:test";
import { fixtureSession, FIXTURE_START } from "../src/devtools/fixtures";
import { toHar } from "../src/devtools/model/har";
import { cacheBadge, phases, rowStatus } from "../src/devtools/model/network";
import { createSession } from "../src/devtools/model/session";

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
    ...events.filter((e) => e.event.pluginId === "airtty-server"),
    ...events.filter((e) => e.event.pluginId !== "airtty-server"),
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

test("a HAR export carries timings and the airtty fields", () => {
  const session = loaded();
  const har = toHar(session.network.rows(), session.network.derive());
  expect(har.log.entries).toHaveLength(10);
  const first = har.log.entries[0];
  expect(first?.request).toMatchObject({
    method: "GET",
    url: "http://airtty.invalid/render?route=%2F&href=%2F",
  });
  expect(first?.timings).toMatchObject({ blocked: 2, wait: 44 });
  expect(first?._airtty).toMatchObject({ callId: "c1", cause: "navigation", cache: "miss" });
  expect(har.log.entries.find((e) => e._airtty.callId === "c6")?._airtty).toMatchObject({
    doubleInvalidation: "action:c4",
  });
});
