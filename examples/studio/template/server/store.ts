import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

// The app's data lives in data/, the only directory its Server may write: it survives
// every change of the code (STUDIO_DATA is set by studio; data/ when run by hand).
const directory = process.env.STUDIO_DATA ?? "data";
mkdirSync(directory, { recursive: true });
const db = new Database(join(directory, "app.sqlite"));
db.run(
  "CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL)",
);
db.run("INSERT OR IGNORE INTO counter (id, value) VALUES (1, 0)");

export function count(): number {
  const row = db.query<{ value: number }, []>("SELECT value FROM counter WHERE id = 1").get();
  return row?.value ?? 0;
}
export function add(step: number): number {
  db.run("UPDATE counter SET value = value + ? WHERE id = 1", [step]);
  return count();
}
