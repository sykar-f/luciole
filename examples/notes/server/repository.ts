import "server-only";
import { Database } from "bun:sqlite";
import { getSession } from "luciole/server";
import { z } from "zod";
import type { Note, SaveResult, Snapshot } from "../components/draft";
import { StoredResult } from "./schemas";
import { SEEDS } from "./seeds";
const env = z
  .object({
    NOTES_DB: z.string().default("notes.sqlite"),
    LUCIOLE_USER: z.string().default("local"),
  })
  .parse(process.env);
export const MAX_VALUE = 20_000;
const db = new Database(env.NOTES_DB, {
  create: true,
});
db.exec(
  "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY, owner TEXT NOT NULL,title TEXT NOT NULL,value TEXT NOT NULL,version INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS operations(owner TEXT NOT NULL,id TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(owner,id));",
);
// Databases written before notes were sorted by date and could be deleted gain the columns.
const columns = new Set(
  db
    .query<{ name: string }, []>("PRAGMA table_info(notes)")
    .all()
    .map((column) => column.name),
);
if (!columns.has("updated"))
  db.exec("ALTER TABLE notes ADD COLUMN updated INTEGER NOT NULL DEFAULT 0");
// A deleted note is kept (with its deletion time) until the user's Undo, or forever.
if (!columns.has("deleted")) db.exec("ALTER TABLE notes ADD COLUMN deleted INTEGER");

const WELCOME = `Notes are written in **Markdown** and kept in *SQLite* on the Server.

## Getting around

- Click anywhere in a note to edit it, then **Done** to read it again
- Click a title to rename its note
- **New note** starts a blank one; the search box filters them all
- Hover a note in the list for its menu, or right-click it

\`\`\`ts
// What the list on the left reads, cached until a save invalidates it
export async function notesOf(owner: string) {
  cacheTag(notesTag(owner));
  return listNotes(owner);
}
\`\`\`

> Changes are saved on their own, a moment after you stop typing.`;
const SHOPPING = `## This week

1. Coffee beans
2. Oat milk
3. Basil, *lots of it*

Ask about the **market** on Saturday.`;
const owner = env.LUCIOLE_USER;
// The day the examples were written: the same dates on every screen, captures included.
const SEEDED = Date.parse("2026-09-23T09:00:00Z");
for (const [id, title, value, edited] of [
  ["1", "Welcome to Notes", WELCOME, SEEDED],
  ["2", "Shopping list", SHOPPING, SEEDED],
  ...SEEDS.map(([id, title, value, edited]) => [id, title, value, Date.parse(edited)] as const),
] as const)
  db.query("INSERT OR IGNORE INTO notes VALUES(?,?,?,?,1,?,NULL)").run(
    id,
    owner,
    title,
    value,
    edited,
  );

const NOTE = "SELECT id,title,value,version,updated FROM notes";
// Reads take the owner as an argument: server/queries.ts caches them, and a cached
// function never reads the session.
export function listNotes(owner: string): Note[] {
  return db
    .query<Note, [string]>(`${NOTE} WHERE owner=? AND deleted IS NULL ORDER BY updated DESC, id`)
    .all(owner);
}
export function findNote(owner: string, id: string): Note | null {
  return db
    .query<Note, [string, string]>(`${NOTE} WHERE id=? AND owner=? AND deleted IS NULL`)
    .get(id, owner);
}
function loadNote(id: string) {
  const note = findNote(getSession().userId, id);
  if (!note) throw new Error("This note was deleted");
  return note;
}
// Arguments are validated by the Server Functions (actions/notes.ts) before reaching here.
export function operation(id: string): SaveResult | null {
  const row = db
    .query<{ result: string }, [string, string]>(
      "SELECT result FROM operations WHERE owner=? AND id=?",
    )
    .get(getSession().userId, id);
  return row ? StoredResult.parse(JSON.parse(row.result)) : null;
}
export function save(snapshot: Snapshot): SaveResult {
  return db
    .transaction(() => {
      const previous = operation(snapshot.operationId);
      if (previous) return previous;
      const note = loadNote(snapshot.id);
      let result: SaveResult;
      if (snapshot.value.length > MAX_VALUE)
        result = {
          ok: false,
          error: `A note holds up to ${MAX_VALUE} characters`,
          operationId: snapshot.operationId,
        };
      else if (note.version !== snapshot.version)
        result = {
          ok: false,
          error: "This note changed elsewhere",
          operationId: snapshot.operationId,
          conflict: true,
        };
      else {
        db.query("UPDATE notes SET value=?,version=version+1,updated=? WHERE id=? AND owner=?").run(
          snapshot.value.trimEnd(),
          Date.now(),
          note.id,
          getSession().userId,
        );
        result = {
          ok: true,
          note: loadNote(note.id),
          operationId: snapshot.operationId,
        };
      }
      db.query("INSERT INTO operations VALUES(?,?,?)").run(
        getSession().userId,
        snapshot.operationId,
        JSON.stringify(result),
      );
      return result;
    })
    .immediate();
}
/** Hexadecimal digits of a new note's id: short in a route, unique enough for one notebook. */
const ID_LENGTH = 8;
/** A blank note, dated now: it opens at the top of the list. */
export function create(): Note {
  const id = crypto.randomUUID().slice(0, ID_LENGTH);
  db.query("INSERT INTO notes VALUES(?,?,'','',1,?,NULL)").run(id, getSession().userId, Date.now());
  return loadNote(id);
}
/** A title is not part of the Draft: renaming never conflicts with a save in flight. */
export function rename(id: string, title: string): Note {
  loadNote(id);
  db.query("UPDATE notes SET title=?,updated=? WHERE id=? AND owner=?").run(
    title,
    Date.now(),
    id,
    getSession().userId,
  );
  return loadNote(id);
}
export function remove(id: string) {
  loadNote(id);
  db.query("UPDATE notes SET deleted=? WHERE id=? AND owner=?").run(
    Date.now(),
    id,
    getSession().userId,
  );
}
/** Undoes `remove`: the note comes back where its date puts it. */
export function restore(id: string): Note {
  db.query("UPDATE notes SET deleted=NULL WHERE id=? AND owner=?").run(id, getSession().userId);
  return loadNote(id);
}
