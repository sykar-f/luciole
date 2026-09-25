/**
 * `bun:sqlite` in the in-browser Server (docs/WEB.md, W9): the part of its API airtty's
 * applications use (`Database`, `exec`, `run`, `query`/`prepare` with `all`, `get`, `run`,
 * `values`, `transaction` and its `deferred`/`immediate`/`exclusive` forms), on SQLite's
 * official WebAssembly build.
 *
 * A database lives in memory, where SQLite is synchronous as `bun:sqlite` is; its file name
 * only names its snapshot (server/snapshots.ts). `configureDatabases` must run before the
 * application's Server code opens one: it gives the images read from storage.
 */
import init, { type Database as WasmDatabase, type SqlValue } from "@sqlite.org/sqlite-wasm";

const sqlite3 = await init();
const { capi, wasm } = sqlite3;

let images = new Map<string, Uint8Array>();
const opened = new Map<string, Database>();

/** The stored images databases open from; call before the application's Server code. */
export function configureDatabases(stored: Map<string, Uint8Array>) {
  images = stored;
}
/** Every open database's current image, by name: what the Worker persists. */
export function databaseImages(): Map<string, Uint8Array<ArrayBuffer>> {
  return new Map([...opened].map(([name, db]) => [name, db.serialize()]));
}

type Parameters = readonly unknown[];
const isBindable = (value: unknown): value is SqlValue =>
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "bigint" ||
  value instanceof Uint8Array;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !(value instanceof Uint8Array);

/**
 * `?` parameters in order, or one object of `$name` parameters, as bun:sqlite takes them;
 * none at all when there are none (SQLite's module refuses an empty binding).
 */
function binding(parameters: Parameters) {
  if (parameters.length === 0) return undefined;
  const [first] = parameters;
  if (parameters.length === 1 && isRecord(first)) {
    const named: Record<string, SqlValue> = {};
    for (const [key, value] of Object.entries(first)) named[key] = toSql(value);
    return named;
  }
  return parameters.map(toSql);
}
function toSql(value: unknown): SqlValue {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === undefined) return null;
  if (isBindable(value)) return value;
  throw new TypeError(`bun:sqlite (browser): cannot bind ${typeof value}`);
}

// SQLite's module builds rows without a prototype; bun:sqlite's are plain objects, which
// Flight and the "use cache" codec accept.
const plain = (row: Record<string, SqlValue>): Record<string, SqlValue> => ({ ...row });

class Statement {
  readonly #db: WasmDatabase;
  readonly #sql: string;
  constructor(db: WasmDatabase, sql: string) {
    this.#db = db;
    this.#sql = sql;
  }
  all(...parameters: Parameters): Record<string, SqlValue>[] {
    return this.#db.selectObjects(this.#sql, binding(parameters)).map(plain);
  }
  get(...parameters: Parameters): Record<string, SqlValue> | null {
    const row = this.#db.selectObject(this.#sql, binding(parameters));
    return row ? plain(row) : null;
  }
  values(...parameters: Parameters): SqlValue[][] {
    return this.#db.selectArrays(this.#sql, binding(parameters));
  }
  run(...parameters: Parameters) {
    this.#db.exec({ sql: this.#sql, bind: binding(parameters) });
    return {
      changes: this.#db.changes(),
      lastInsertRowid: Number(capi.sqlite3_last_insert_rowid(this.#db)),
    };
  }
  finalize() {}
}

export class Database {
  readonly #db: WasmDatabase;
  readonly #statements = new Map<string, Statement>();
  readonly filename: string;

  constructor(filename = ":memory:", _options?: unknown) {
    this.filename = filename;
    this.#db = new sqlite3.oo1.DB(":memory:");
    const image = images.get(filename);
    if (image) {
      const pointer = wasm.allocFromTypedArray(image);
      this.#db.checkRc(
        capi.sqlite3_deserialize(
          this.#db,
          "main",
          pointer,
          image.byteLength,
          image.byteLength,
          capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE,
        ),
      );
    }
    if (filename !== ":memory:") opened.set(filename, this);
  }
  exec(sql: string, ...parameters: Parameters) {
    if (parameters.length) this.#db.exec({ sql, bind: binding(parameters) });
    else this.#db.exec(sql);
  }
  run(sql: string, ...parameters: Parameters) {
    return this.prepare(sql).run(...parameters);
  }
  prepare(sql: string) {
    return new Statement(this.#db, sql);
  }
  /** Cached per SQL text, as bun:sqlite's `query`. */
  query(sql: string) {
    const known = this.#statements.get(sql);
    if (known) return known;
    const statement = this.prepare(sql);
    this.#statements.set(sql, statement);
    return statement;
  }
  /** `fn` in a transaction, and its `deferred`, `immediate` and `exclusive` forms. */
  transaction<A extends unknown[], R>(body: (...args: A) => R) {
    const run =
      (begin: string) =>
      (...args: A): R => {
        this.#db.exec(begin);
        try {
          const result = body(...args);
          this.#db.exec("COMMIT");
          return result;
        } catch (error) {
          this.#db.exec("ROLLBACK");
          throw error;
        }
      };
    return Object.assign(run("BEGIN"), {
      deferred: run("BEGIN DEFERRED"),
      immediate: run("BEGIN IMMEDIATE"),
      exclusive: run("BEGIN EXCLUSIVE"),
    });
  }
  serialize(): Uint8Array<ArrayBuffer> {
    return capi.sqlite3_js_db_export(this.#db);
  }
  close() {
    opened.delete(this.filename);
    this.#db.close();
  }
}
export default { Database };
