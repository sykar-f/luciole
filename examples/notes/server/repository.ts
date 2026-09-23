import "server-only";
import { Database } from "bun:sqlite";
import { getSession } from "airtty/server";
import { z } from "zod";
import type { Note, SaveResult, Snapshot } from "../components/draft";
import { StoredResult } from "./schemas";
const env = z
  .object({
    NOTES_DB: z.string().default("notes.sqlite"),
    AIRTTY_USER: z.string().default("local"),
  })
  .parse(process.env);
const MAX_VALUE = 2000;
const db = new Database(env.NOTES_DB, {
  create: true,
});
db.exec(
  "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY, owner TEXT NOT NULL,title TEXT NOT NULL,value TEXT NOT NULL,version INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS operations(owner TEXT NOT NULL,id TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(owner,id));",
);
const owner = env.AIRTTY_USER;
for (const [id, title] of [
  ["1", "First note"],
  ["2", "Second note"],
])
  db.query("INSERT OR IGNORE INTO notes VALUES(?,?,?,?,1)").run(id, owner, title, "");
export function listNotes(): Note[] {
  return db
    .query<Note, [string]>("SELECT id,title,value,version FROM notes WHERE owner=? ORDER BY id")
    .all(getSession().userId);
}
export function loadNote(id: string): Note {
  const row = db
    .query<Note, [string, string]>(
      "SELECT id,title,value,version FROM notes WHERE id=? AND owner=?",
    )
    .get(id, getSession().userId);
  if (!row) throw new Error("Note unavailable");
  return row;
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
      if (!snapshot.value.trim() || snapshot.value.length > MAX_VALUE)
        result = {
          ok: false,
          error: `Enter 1–${MAX_VALUE} characters`,
          operationId: snapshot.operationId,
        };
      else if (note.version !== snapshot.version)
        result = {
          ok: false,
          error: "Version conflict: keep your Draft or discard to reload",
          operationId: snapshot.operationId,
        };
      else {
        const value = snapshot.value.trim();
        db.query("UPDATE notes SET value=?,version=version+1 WHERE id=? AND owner=?").run(
          value,
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
