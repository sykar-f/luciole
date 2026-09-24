import { Database } from "bun:sqlite";
import { z } from "zod";
import type { CacheEntry, CacheHandler } from "./handler";

const SQLITE_ENTRIES = 10_000;
// A row is read back from a file other processes and builds may have written.
const Row = z.object({
  value: z.string(),
  tags: z.string(),
  created: z.number(),
  revalidate: z.number(),
  expire: z.number().nullable(),
});
const Tags = z.array(z.string());
/**
 * Entries in a SQLite file (`bun:sqlite`): they survive restarts and are shared by the
 * Server processes of one machine. Entries of a previous build are never read (the build
 * is part of each key) and leave with the oldest ones once `maxEntries` is reached.
 */
export function sqliteCache({
  path,
  maxEntries = SQLITE_ENTRIES,
}: {
  path: string;
  maxEntries?: number;
}) {
  const db = new Database(path, { create: true });
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;" +
      "CREATE TABLE IF NOT EXISTS airtty_cache(key TEXT PRIMARY KEY, value TEXT NOT NULL, tags TEXT NOT NULL, created REAL NOT NULL, revalidate REAL NOT NULL, expire REAL);" +
      "CREATE TABLE IF NOT EXISTS airtty_cache_tags(tag TEXT NOT NULL, key TEXT NOT NULL REFERENCES airtty_cache(key) ON DELETE CASCADE, PRIMARY KEY(tag, key));" +
      "CREATE INDEX IF NOT EXISTS airtty_cache_created ON airtty_cache(created);",
  );
  const select = db.query(
    "SELECT value, tags, created, revalidate, expire FROM airtty_cache WHERE key=?",
  );
  const remove = db.query("DELETE FROM airtty_cache WHERE key=?");
  const insert = db.query("INSERT INTO airtty_cache VALUES(?,?,?,?,?,?)");
  const tag = db.query("INSERT INTO airtty_cache_tags VALUES(?,?)");
  const evict = db.query(
    "DELETE FROM airtty_cache WHERE key IN (SELECT key FROM airtty_cache ORDER BY created DESC LIMIT -1 OFFSET ?)",
  );
  const write = db.transaction((key: string, entry: CacheEntry) => {
    remove.run(key);
    insert.run(
      key,
      entry.value,
      JSON.stringify(entry.tags),
      entry.createdAt,
      entry.revalidate,
      Number.isFinite(entry.expire) ? entry.expire : null,
    );
    for (const name of new Set(entry.tags)) tag.run(name, key);
    evict.run(maxEntries);
  });
  return {
    get(key) {
      const row = select.get(key);
      if (!row) return undefined;
      const parsed = Row.parse(row);
      return {
        value: parsed.value,
        tags: Tags.parse(JSON.parse(parsed.tags)),
        createdAt: parsed.created,
        revalidate: parsed.revalidate,
        expire: parsed.expire ?? Infinity,
      };
    },
    set(key, entry) {
      write.immediate(key, entry);
    },
    invalidateTags(tags) {
      if (!tags.length) return;
      db.query(
        `DELETE FROM airtty_cache WHERE key IN (SELECT key FROM airtty_cache_tags WHERE tag IN (${tags.map(() => "?").join(",")}))`,
      ).run(...tags);
    },
  } satisfies CacheHandler;
}
