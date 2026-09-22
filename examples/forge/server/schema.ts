import { Database } from "bun:sqlite";

// Every mutation writes its business change, its audit event and its operation result
// in one IMMEDIATE transaction: a lost response can always be resolved, never replayed.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('maintainer','contributor','reader')));
CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE TABLE IF NOT EXISTS repos(
  slug TEXT PRIMARY KEY, description TEXT NOT NULL, default_branch TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS branches(
  repo TEXT NOT NULL REFERENCES repos(slug), name TEXT NOT NULL, author TEXT NOT NULL,
  PRIMARY KEY(repo, name));
CREATE TABLE IF NOT EXISTS branch_files(
  repo TEXT NOT NULL, branch TEXT NOT NULL, path TEXT NOT NULL,
  before TEXT NOT NULL, after TEXT NOT NULL, PRIMARY KEY(repo, branch, path));
CREATE TABLE IF NOT EXISTS pulls(
  id INTEGER PRIMARY KEY, repo TEXT NOT NULL REFERENCES repos(slug), number INTEGER NOT NULL,
  title TEXT NOT NULL, author TEXT NOT NULL REFERENCES users(id),
  state TEXT NOT NULL CHECK(state IN ('open','merged','closed')),
  head_branch TEXT NOT NULL, base_branch TEXT NOT NULL, revision INTEGER NOT NULL,
  description TEXT NOT NULL, description_version INTEGER NOT NULL,
  merged_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(repo, number));
CREATE TABLE IF NOT EXISTS pull_files(
  pull_id INTEGER NOT NULL REFERENCES pulls(id), revision INTEGER NOT NULL, path TEXT NOT NULL,
  language TEXT NOT NULL, before TEXT NOT NULL, after TEXT NOT NULL, patch TEXT NOT NULL,
  additions INTEGER NOT NULL, deletions INTEGER NOT NULL,
  PRIMARY KEY(pull_id, revision, path));
CREATE TABLE IF NOT EXISTS comments(
  id INTEGER PRIMARY KEY, pull_id INTEGER NOT NULL REFERENCES pulls(id),
  author TEXT NOT NULL REFERENCES users(id), body TEXT NOT NULL,
  path TEXT, side TEXT CHECK(side IN ('old','new')), line INTEGER,
  revision INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reviews(
  id INTEGER PRIMARY KEY, pull_id INTEGER NOT NULL REFERENCES pulls(id),
  reviewer TEXT NOT NULL REFERENCES users(id),
  verdict TEXT NOT NULL CHECK(verdict IN ('approve','changes')),
  revision INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS composers(
  user_id TEXT NOT NULL, slot TEXT NOT NULL, version INTEGER NOT NULL,
  PRIMARY KEY(user_id, slot));
CREATE TABLE IF NOT EXISTS checks(
  id INTEGER PRIMARY KEY, pull_id INTEGER NOT NULL REFERENCES pulls(id),
  revision INTEGER NOT NULL, name TEXT NOT NULL, attempt INTEGER NOT NULL,
  started_at INTEGER NOT NULL, fail_until INTEGER NOT NULL DEFAULT 0,
  UNIQUE(pull_id, revision, name));
CREATE TABLE IF NOT EXISTS operations(
  actor TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, result TEXT NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY(actor, id));
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL,
  call_id TEXT, operation_id TEXT, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS faults(kind TEXT PRIMARY KEY);
`;

export function openDatabase(path: string) {
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  db.exec(SCHEMA);
  return db;
}
