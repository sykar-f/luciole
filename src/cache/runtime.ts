import { z } from "zod";
import { isAsyncIterable } from "../guards";
import { decodeValue, encodeValue, keyOf } from "./codec";
import { memoryCache, type CacheEntry, type CacheHandler } from "./handler";
import { cacheScope, renderTags, type CacheLife, type CacheScope } from "./scope";

/**
 * What the cache reports to `serve({ instrument })`, beside the request events. `key` is
 * the hashed key, `fn` the function (`path#name`), `tags` those of the entry (or the
 * invalidated ones), `ms` the time the operation took, `at` epoch milliseconds.
 * `hit` includes a caller served by a concurrent computation of the same key; `miss` is
 * reported once the function returned; `stale` served an old entry while it refreshes.
 */
export type CacheEvent = {
  type: "cache";
  op: "hit" | "miss" | "stale" | "write" | "invalidate";
  key: string;
  fn: string;
  tags: readonly string[];
  callId: string;
  ms: number;
  at: number;
};

/** Next.js's profiles, in seconds: `stale` for Clients, then `revalidate` and `expire`. */
const MINUTE = 60,
  HOUR = 3600,
  DAY = 86_400,
  WEEK = 604_800,
  MONTH = 2_592_000,
  FIVE_MINUTES = 300,
  FIFTEEN_MINUTES = 900;
export const CACHE_PROFILES = {
  default: { stale: FIVE_MINUTES, revalidate: FIFTEEN_MINUTES, expire: Infinity },
  seconds: { stale: 30, revalidate: 1, expire: MINUTE },
  minutes: { stale: FIVE_MINUTES, revalidate: MINUTE, expire: HOUR },
  hours: { stale: FIVE_MINUTES, revalidate: HOUR, expire: DAY },
  days: { stale: FIVE_MINUTES, revalidate: DAY, expire: WEEK },
  weeks: { stale: FIVE_MINUTES, revalidate: WEEK, expire: MONTH },
  max: { stale: FIVE_MINUTES, revalidate: MONTH, expire: Infinity },
} as const satisfies Record<string, CacheLife>;
export type CacheProfile = keyof typeof CACHE_PROFILES;

const Seconds = z.number().nonnegative();
const Life = z
  .strictObject({
    stale: Seconds.optional(),
    revalidate: Seconds.optional(),
    expire: Seconds.optional(),
  })
  .transform((life) => ({ ...CACHE_PROFILES.default, ...life }))
  .refine((life) => life.revalidate <= life.expire, "revalidate must not exceed expire");
const MAX_TAGS = 64;
/** Tags travel in a header, comma-separated: visible ASCII, no comma, no space. */
export const Tag = z
  .string()
  .regex(/^[\x21-\x2b\x2d-\x7e]{1,256}$/, "tags are 1–256 visible ASCII characters, no comma");

// Checked at run time too: JavaScript callers are not held to `CacheProfile`.
function profile(name: string): CacheLife {
  const found = Object.entries(CACHE_PROFILES).find(([known]) => known === name);
  if (!found) throw new Error(`Unknown cache profile: ${name}`);
  return found[1];
}
function scope(api: string): CacheScope {
  const current = cacheScope.getStore();
  if (!current) throw new Error(`${api} is only available inside a "use cache" function`);
  return current;
}
// Always a new object of three fields: `b` may be a whole entry, value and tags included.
const shortest = (a: CacheLife | undefined, b: CacheLife): CacheLife => ({
  stale: Math.min(a?.stale ?? Infinity, b.stale),
  revalidate: Math.min(a?.revalidate ?? Infinity, b.revalidate),
  expire: Math.min(a?.expire ?? Infinity, b.expire),
});

/**
 * How long the running `"use cache"` result stays fresh: a profile name or seconds. Called
 * more than once (or by nested cached functions), the shortest duration of each wins.
 */
export function cacheLife(life: CacheProfile | Partial<CacheLife>) {
  const current = scope("cacheLife()");
  current.life = shortest(
    current.life,
    typeof life === "string" ? profile(life) : Life.parse(life),
  );
}

/** Labels the running `"use cache"` result; `invalidate({ tag })` drops every labelled one. */
export function cacheTag(...tags: string[]) {
  const current = scope("cacheTag()");
  for (const tag of tags) current.tags.add(Tag.parse(tag));
  if (current.tags.size > MAX_TAGS) throw new Error(`At most ${MAX_TAGS} tags per cached result`);
}

type Settings = {
  buildId: string;
  handler: CacheHandler;
  onEvent?: (event: CacheEvent) => void;
  callId: () => string | undefined;
};
let settings: Settings = { buildId: "", handler: memoryCache(), callId: () => undefined };
/** Called by `serve()`: the build, the application's handler and the instrument. */
export function configureCache(next: {
  buildId: string;
  handler?: CacheHandler;
  onEvent?: (event: CacheEvent) => void;
  callId: () => string | undefined;
}) {
  settings = { ...next, handler: next.handler ?? settings.handler };
}

const MS_PER_SECOND = 1000;
const now = () => performance.timeOrigin + performance.now();
function emit(op: CacheEvent["op"], key: string, fn: string, tags: readonly string[], ms: number) {
  settings.onEvent?.({
    type: "cache",
    op,
    key,
    fn,
    tags,
    callId: settings.callId() ?? "",
    ms: Math.round(ms),
    at: now(),
  });
}

// Concurrent calls of one key share one computation, unless a tag invalidation happened
// since it started (`epoch`): its result may predate the change.
type Computation = { epoch: number; entry: Promise<CacheEntry> };
const inflight = new Map<string, Computation>();
let epoch = 0;
const invalidatedAt = new Map<string, number>();

/** A result read from the cache counts for the caller as if it had run the function. */
function adopt(entry: CacheEntry) {
  const parent = cacheScope.getStore();
  if (parent) {
    for (const tag of entry.tags) parent.tags.add(tag);
    parent.life = shortest(parent.life, entry);
  }
  const rendered = renderTags.getStore();
  for (const tag of entry.tags) rendered?.add(tag);
}

function compute(key: string, fn: string, run: () => Promise<unknown>): Computation {
  const started = epoch;
  const entry = (async () => {
    const own: CacheScope = { fn, tags: new Set(), life: undefined };
    const value = await cacheScope.run(own, run);
    if (isAsyncIterable(value))
      throw new Error(`"use cache" ${fn} returned an async iterable: streams are not cacheable`);
    const result: CacheEntry = {
      value: await encodeValue(value),
      tags: [...own.tags],
      createdAt: Date.now(),
      ...(own.life ?? CACHE_PROFILES.default),
    };
    // Invalidated while computing: the result may predate the change, never store it.
    if (!result.tags.some((tag) => (invalidatedAt.get(tag) ?? -1) > started)) {
      const writing = performance.now();
      await settings.handler.set(key, result);
      emit("write", key, fn, result.tags, performance.now() - writing);
    }
    return result;
  })();
  const computation = { epoch: started, entry };
  inflight.set(key, computation);
  const done = () => {
    if (inflight.get(key) === computation) inflight.delete(key);
    if (!inflight.size) invalidatedAt.clear();
  };
  entry.then(done, done);
  return computation;
}

/**
 * The wrapper the build puts around each `"use cache"` export (`fn` is `path#name`): the
 * result is keyed by build, function and arguments, and shared by every caller.
 */
export function cached(target: (...args: unknown[]) => Promise<unknown>, fn: string) {
  return async (...args: unknown[]): Promise<unknown> => {
    const start = performance.now();
    const key = await keyOf(settings.buildId, fn, args);
    const decoded = (entry: CacheEntry) => {
      adopt(entry);
      return decodeValue(entry.value);
    };
    // Joined before the lookup, and after it: a concurrent caller may have started
    // computing while this one waited for the handler.
    const running = () => {
      const computation = inflight.get(key);
      return computation?.epoch === epoch ? computation : undefined;
    };
    const share = async ({ entry }: Computation) => {
      const shared = await entry;
      emit("hit", key, fn, shared.tags, performance.now() - start);
      return decoded(shared);
    };
    const early = running();
    if (early) return share(early);
    const stored = await settings.handler.get(key);
    const age = stored && (Date.now() - stored.createdAt) / MS_PER_SECOND;
    if (stored && age !== undefined && age < stored.expire) {
      if (age >= stored.revalidate) {
        emit("stale", key, fn, stored.tags, performance.now() - start);
        // Served now, refreshed behind: a failed refresh keeps the entry until it expires.
        if (!inflight.has(key)) compute(key, fn, () => target(...args)).entry.catch(() => {});
      } else emit("hit", key, fn, stored.tags, performance.now() - start);
      return decoded(stored);
    }
    const late = running();
    if (late) return share(late);
    try {
      const entry = await compute(key, fn, () => target(...args)).entry;
      emit("miss", key, fn, entry.tags, performance.now() - start);
      return await decoded(entry);
    } catch (error) {
      emit("miss", key, fn, [], performance.now() - start);
      throw error;
    }
  };
}

/** Drops every entry labelled with one of `tags`, and any computation started before. */
export async function invalidateTags(tags: readonly string[]) {
  const start = performance.now();
  epoch++;
  for (const tag of tags) invalidatedAt.set(tag, epoch);
  await settings.handler.invalidateTags(tags);
  emit("invalidate", "", "", tags, performance.now() - start);
}
