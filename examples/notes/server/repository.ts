import "server-only";
import { Database } from "bun:sqlite";
import { getSession } from "airtty/server";
import type { Note, SaveResult, Snapshot } from "../components/draft";
const db = new Database(process.env.NOTES_DB ?? "notes.sqlite", {
  create: true,
});
db.exec(
  "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY, owner TEXT NOT NULL,title TEXT NOT NULL,value TEXT NOT NULL,version INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS operations(owner TEXT NOT NULL,id TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(owner,id));",
);
const owner = process.env.AIRTTY_USER ?? "local";
for (const [id, title] of [
  ["1", "First note"],
  ["2", "Second note"],
])
  db.query("INSERT OR IGNORE INTO notes VALUES(?,?,?,?,1)").run(id, owner, title, "");
export function listNotes(): Note[] {
  return db
    .query("SELECT id,title,value,version FROM notes WHERE owner=? ORDER BY id")
    .all(getSession().userId) as Note[];
}
export function loadNote(id: string): Note {
  const row = db
    .query("SELECT id,title,value,version FROM notes WHERE id=? AND owner=?")
    .get(id, getSession().userId) as Note | null;
  if (!row) throw new Error("Note unavailable");
  return row;
}
export function operation(id: string): SaveResult | null {
  if (typeof id !== "string" || id.length > 100) throw new Error("Invalid operation");
  const row = db
    .query("SELECT result FROM operations WHERE owner=? AND id=?")
    .get(getSession().userId, id) as { result: string } | null;
  return row ? JSON.parse(row.result) : null;
}
export function save(snapshot: Snapshot): SaveResult {
  if (
    !snapshot ||
    typeof snapshot.operationId !== "string" ||
    !/^[0-9a-f-]{36}$/.test(snapshot.operationId) ||
    typeof snapshot.id !== "string" ||
    typeof snapshot.value !== "string" ||
    !Number.isSafeInteger(snapshot.version)
  )
    throw new Error("Invalid save arguments");
  return db
    .transaction(() => {
      const previous = operation(snapshot.operationId);
      if (previous) return previous;
      const note = loadNote(snapshot.id);
      let result: SaveResult;
      if (!snapshot.value.trim() || snapshot.value.length > 2000)
        result = {
          ok: false,
          error: "Enter 1–2000 characters",
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
