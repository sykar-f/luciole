import { AsyncLocalStorage } from "node:async_hooks";

/** Seconds; `Infinity` never expires. See `cacheLife` (src/cache/runtime.ts). */
export type CacheLife = { stale: number; revalidate: number; expire: number };
/** The `"use cache"` function running now: what `cacheTag` and `cacheLife` declare. */
export type CacheScope = { fn: string; tags: Set<string>; life: CacheLife | undefined };
export const cacheScope = new AsyncLocalStorage<CacheScope>();
/**
 * The tags a `/render` touched, hits and misses alike: the Server sends them to the Client
 * with the page, so a tag invalidation revalidates only the routes that read it.
 */
export const renderTags = new AsyncLocalStorage<Set<string>>();

/**
 * Throws inside a `"use cache"` function: its result is shared by every caller of the
 * same arguments, so per-request identity would leak one user's data to another.
 */
export function assertUncached(api: string) {
  const scope = cacheScope.getStore();
  if (scope)
    throw new Error(
      `${api} is unavailable inside "use cache" (${scope.fn}): pass the identity as an argument`,
    );
}
