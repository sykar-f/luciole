import { afterAll, beforeEach, expect, test } from "bun:test";
import React from "react";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryCache, type CacheHandler } from "../src/cache/handler";
import {
  cacheLife,
  cacheTag,
  cached,
  configureCache,
  invalidateTags,
  type CacheEvent,
} from "../src/cache/runtime";
import { sqliteCache } from "../src/cache/sqlite";
import { messageOf } from "../src/guards";
import { getOptionalSession, getSession } from "../src/server";

// Run by tests/cache.test.ts under the `react-server` condition, like the Server itself:
// `bun test` alone resolves React's Client build. tests/helpers.ts imports `act`, which
// that build lacks, hence this local copy of its `rejectionOf`.
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("Expected a rejection, the promise resolved");
}

// The runtime keeps one configuration per process, as `serve()` sets it: each test starts
// with a fresh handler, and the events it caused.
let events: CacheEvent[] = [];
const use = (handler: CacheHandler = memoryCache()) => {
  events = [];
  configureCache({
    buildId: "build-1",
    handler,
    onEvent: (event) => events.push(event),
    callId: () => "call-1",
  });
};
beforeEach(() => use());
const ops = () => events.map((e) => e.op);

test("a result is computed once per arguments, then served from the cache", async () => {
  let runs = 0;
  const read = cached(async (id: unknown, at: unknown) => {
    cacheTag("notes");
    runs++;
    return { id, at, runs, seen: new Map([[1, new Set(["a"])]]) };
  }, "server/q.ts#read");
  const first = await read("1", new Date(0));
  expect(await read("1", new Date(0))).toEqual(first);
  expect(first).toEqual({
    id: "1",
    at: new Date(0),
    runs: 1,
    seen: new Map([[1, new Set(["a"])]]),
  });
  // A copy per caller: mutating one never reaches the next.
  expect(await read("1", new Date(0))).not.toBe(first);
  await read("2", new Date(0));
  expect(runs).toBe(2);
  expect(ops()).toEqual(["write", "miss", "hit", "hit", "write", "miss"]);
  expect(events[0]).toMatchObject({
    type: "cache",
    fn: "server/q.ts#read",
    tags: ["notes"],
    callId: "call-1",
  });
  expect(events[0].key).toMatch(/^[0-9a-f]{64}$/);
  expect(events[4].key).not.toBe(events[0].key);
});

test("the build is part of the key", async () => {
  let runs = 0;
  const read = cached(async () => ++runs, "server/q.ts#build");
  const handler = memoryCache();
  use(handler);
  await read();
  configureCache({ buildId: "build-2", handler, callId: () => undefined });
  expect(await read()).toBe(2);
});

test("an entry is served stale after revalidate, refreshed behind, and dropped after expire", async () => {
  let runs = 0;
  const read = cached(async () => {
    cacheLife({ revalidate: 0.05, expire: 0.5 });
    return ++runs;
  }, "server/q.ts#life");
  expect(await read()).toBe(1);
  await Bun.sleep(70);
  // Stale: the old value at once, a new one computed behind it.
  expect(await read()).toBe(1);
  expect(ops()).toEqual(["write", "miss", "stale"]);
  while (ops().length < 4) await Bun.sleep(1);
  expect(ops()[3]).toBe("write");
  expect(await read()).toBe(2);
  await Bun.sleep(550);
  expect(await read()).toBe(3);
  expect(ops().slice(-2)).toEqual(["write", "miss"]);
});

test("profiles, the shortest life and invalid ones", async () => {
  const read = cached(async () => {
    cacheLife("hours");
    cacheLife({ revalidate: 5 });
    return 1;
  }, "server/q.ts#profiles");
  const handler = memoryCache();
  use(handler);
  await read();
  const [write] = events;
  const entry = handler.get(write.key);
  expect(entry).toMatchObject({ revalidate: 5, expire: 86_400 });
  // Client freshness is a page's staleTime: cacheLife has no `stale` to mislead with.
  expect(entry && "stale" in entry).toBe(false);
  const stale = cached(async () => {
    Reflect.apply(cacheLife, undefined, [{ stale: 30 }]);
  }, "server/q.ts#stale");
  expect(messageOf(await rejectionOf(stale()))).toContain("stale");
  const unknown = cached(async () => {
    // A JavaScript caller is not held to the profile names: checked at run time.
    Reflect.apply(cacheLife, undefined, ["forever"]);
  }, "server/q.ts#unknown");
  expect(messageOf(await rejectionOf(unknown()))).toContain("Unknown cache profile");
  const inverted = cached(async () => cacheLife({ revalidate: 10, expire: 1 }), "server/q.ts#inv");
  expect(messageOf(await rejectionOf(inverted()))).toContain("revalidate must not exceed expire");
  expect(() => cacheTag("x")).toThrow('only available inside a "use cache" function');
  expect(() => cacheLife("max")).toThrow('only available inside a "use cache" function');
  const comma = cached(async () => cacheTag("a,b"), "server/q.ts#comma");
  expect(messageOf(await rejectionOf(comma()))).toContain("tags are");
});

test("a tag invalidation drops its entries only", async () => {
  let runs = 0;
  const note = cached(async (id: unknown) => {
    cacheTag(`note:${String(id)}`, "notes");
    return `${String(id)}:${++runs}`;
  }, "server/q.ts#note");
  await note("1");
  await note("2");
  await invalidateTags(["note:1"]);
  expect(await note("1")).toBe("1:3");
  expect(await note("2")).toBe("2:2");
  await invalidateTags(["notes"]);
  expect(await note("2")).toBe("2:4");
  expect(events.filter((e) => e.op === "invalidate").map((e) => e.tags)).toEqual([
    ["note:1"],
    ["notes"],
  ]);
});

test("the session is refused inside a cached function", async () => {
  const leak = cached(async () => getSession().userId, "server/q.ts#leak");
  expect(messageOf(await rejectionOf(leak()))).toBe(
    'getSession() is unavailable inside "use cache" (server/q.ts#leak): pass the identity as an argument',
  );
  const optional = cached(async () => getOptionalSession(), "server/q.ts#optional");
  expect(messageOf(await rejectionOf(optional()))).toContain("getOptionalSession() is unavailable");
  // Nothing was stored: the next call runs again and fails the same way.
  expect(ops()).toEqual(["miss", "miss"]);
});

test("streams, elements and functions are not cacheable", async () => {
  const stream = cached(async () => (async function* () {})(), "server/q.ts#stream");
  expect(messageOf(await rejectionOf(stream()))).toContain("returned an async iterable");
  const nested = cached(async () => ({ body: new ReadableStream() }), "server/q.ts#nested");
  expect(messageOf(await rejectionOf(nested()))).toContain("cannot be a stream");
  const element = cached(async () => React.createElement("text"), "server/q.ts#element");
  expect(messageOf(await rejectionOf(element()))).toContain("result is not serializable");
  const argument = cached(async () => 1, "server/q.ts#argument");
  expect(messageOf(await rejectionOf(argument(() => 1)))).toContain(
    "arguments is not serializable",
  );
});

test("concurrent calls share one computation; an invalidation starts a new one", async () => {
  let runs = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const slow = cached(async () => {
    cacheTag("slow");
    runs++;
    await gate;
    return runs;
  }, "server/q.ts#slow");
  const first = slow();
  const second = slow();
  await Bun.sleep(5);
  // Invalidated while computing: later callers do not join, and the old result is not kept.
  await invalidateTags(["slow"]);
  const third = slow();
  await Bun.sleep(5);
  release();
  expect(await Promise.all([first, second, third])).toEqual([2, 2, 2]);
  expect(runs).toBe(2);
  expect(ops().filter((op) => op === "write")).toHaveLength(1);
  expect(ops()).toContain("hit");
});

test("nested cached calls pass their tags and life to the caller", async () => {
  let inner = 0;
  const leaf = cached(async () => {
    cacheTag("leaf");
    cacheLife("minutes");
    return ++inner;
  }, "server/q.ts#leaf");
  const outer = cached(async () => ({ leaf: await leaf() }), "server/q.ts#outer");
  const handler = memoryCache();
  use(handler);
  expect(await outer()).toEqual({ leaf: 1 });
  const written = events.find((e) => e.op === "write" && e.fn === "server/q.ts#outer");
  expect(written?.tags).toEqual(["leaf"]);
  expect(handler.get(written?.key ?? "")).toMatchObject({ revalidate: 60, expire: 3600 });
  await invalidateTags(["leaf"]);
  expect(await outer()).toEqual({ leaf: 2 });
});

const directory = await mkdtemp(join(tmpdir(), "airtty-cache-sqlite-"));
afterAll(() => rm(directory, { recursive: true, force: true }));
test("the SQLite handler keeps entries across instances, by tag and within its bound", async () => {
  const path = join(directory, "cache.sqlite");
  const createdAt = Date.now();
  const entry = (value: string, tags: string[]) => ({
    value,
    tags,
    createdAt,
    revalidate: 2,
    expire: Infinity,
  });
  const first = sqliteCache({ path, maxEntries: 2 });
  first.set("a", entry("A", ["x", "y"]));
  first.set("b", entry("B", ["y"]));
  const second = sqliteCache({ path, maxEntries: 2 });
  expect(second.get("a")).toEqual(entry("A", ["x", "y"]));
  second.invalidateTags(["x"]);
  expect(first.get("a")).toBeUndefined();
  expect(first.get("b")?.value).toBe("B");
  second.set("c", { ...entry("C", []), createdAt: createdAt + 1 });
  second.set("d", { ...entry("D", []), createdAt: createdAt + 2 });
  expect(first.get("b")).toBeUndefined();
  expect(first.get("d")?.value).toBe("D");
  // Behind the runtime: results decode from the file like from memory.
  use(sqliteCache({ path }));
  let runs = 0;
  const read = cached(async () => ({ runs: ++runs, at: new Date(1) }), "server/q.ts#sqlite");
  await read();
  expect(await read()).toEqual({ runs: 1, at: new Date(1) });
});
