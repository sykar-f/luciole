import { expect, test } from "bun:test";
import { Database as BunDatabase, type SQLQueryBindings } from "bun:sqlite";
import {
  Database as PageDatabase,
  configureDatabases,
  databaseImages,
} from "../packages/luciole/src/web/node/bun-sqlite";

/** The part of bun:sqlite luciole's applications use: both databases must offer it. */
type Statement = {
  all(...params: SQLQueryBindings[]): unknown[];
  get(...params: SQLQueryBindings[]): unknown;
  run(...params: SQLQueryBindings[]): { changes: number };
};
type Sqlite = {
  exec(sql: string): void;
  query(sql: string): Statement;
  transaction<A extends SQLQueryBindings[], R>(
    body: (...args: A) => R,
  ): ((...args: A) => R) & { immediate: (...args: A) => R };
};

// What luciole's applications do with bun:sqlite (examples/notes, forge), on both.
function exercise(db: Sqlite) {
  db.exec("CREATE TABLE notes(id TEXT PRIMARY KEY, title TEXT NOT NULL, version INTEGER NOT NULL)");
  for (const [id, title] of [
    ["1", "First"],
    ["2", "Second"],
  ])
    db.query("INSERT OR IGNORE INTO notes VALUES(?,?,1)").run(id, title);
  const bump = db.transaction((id: string) => {
    db.query("UPDATE notes SET version=version+1 WHERE id=?").run(id);
    return db.query("SELECT version FROM notes WHERE id=?").get(id);
  });
  const failing = db.transaction(() => {
    db.query("UPDATE notes SET title='lost' WHERE id='2'").run();
    throw new Error("rolled back");
  });
  return {
    all: db.query("SELECT * FROM notes ORDER BY id").all(),
    one: db.query("SELECT title FROM notes WHERE id=?").get("2"),
    none: db.query("SELECT title FROM notes WHERE id=?").get("missing"),
    named: db.query("SELECT title FROM notes WHERE id=$id").get({ $id: "1" }),
    immediate: bump.immediate("1"),
    plain: bump("2"),
    rolledBack: (() => {
      try {
        failing();
      } catch {
        return db.query("SELECT title FROM notes WHERE id='2'").get();
      }
    })(),
    changes: db.query("UPDATE notes SET version=0").run().changes,
  };
}

test("the browser's bun:sqlite answers as bun:sqlite does", () => {
  const expected = exercise(new BunDatabase(":memory:"));
  const actual = exercise(new PageDatabase(":memory:"));
  expect(actual).toEqual(expected);
  // Plain objects, as Flight and the "use cache" codec require.
  expect(Object.getPrototypeOf(actual.one)).toBe(Object.prototype);
});

test("a named database reopens from its stored image", () => {
  const first = new PageDatabase("notes.sqlite");
  first.exec("CREATE TABLE t(v TEXT)");
  first.query("INSERT INTO t VALUES(?)").run("kept");
  const images = databaseImages();
  first.close();
  configureDatabases(images);
  const again = new PageDatabase("notes.sqlite");
  expect(again.query("SELECT v FROM t").all()).toEqual([{ v: "kept" }]);
  again.close();
});
