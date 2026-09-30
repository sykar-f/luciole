import type { CacheLife } from "./scope";

/**
 * One stored result. `value` is the encoded result (src/cache/codec.ts), opaque text to a
 * handler; `createdAt` is epoch milliseconds, the durations are seconds.
 */
export type CacheEntry = CacheLife & { value: string; tags: readonly string[]; createdAt: number };
/**
 * Where `"use cache"` results live. Keys already carry the build and the arguments;
 * freshness is decided by the runtime, not the handler. `invalidateTags` must drop every
 * entry holding one of `tags` before it resolves: the Client refetches right after.
 */
export type CacheHandler = {
  get(key: string): CacheEntry | undefined | Promise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry): void | Promise<void>;
  invalidateTags(tags: readonly string[]): void | Promise<void>;
};

const MEMORY_ENTRIES = 1000;
/**
 * The default handler: this process only, least recently used first out. Lost on every
 * restart, including each rebuild of `luciole dev`.
 */
export function memoryCache({ maxEntries = MEMORY_ENTRIES }: { maxEntries?: number } = {}) {
  const entries = new Map<string, CacheEntry>();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      // Map order is insertion order: re-inserting marks it recently used.
      entries.delete(key);
      entries.set(key, entry);
      return entry;
    },
    set(key, entry) {
      entries.delete(key);
      entries.set(key, entry);
      for (const oldest of entries.keys()) {
        if (entries.size <= maxEntries) break;
        entries.delete(oldest);
      }
    },
    invalidateTags(tags) {
      for (const [key, entry] of entries)
        if (entry.tags.some((tag) => tags.includes(tag))) entries.delete(key);
    },
  } satisfies CacheHandler;
}
