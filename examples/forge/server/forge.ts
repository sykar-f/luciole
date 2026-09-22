import type { Database } from "bun:sqlite";
import type { Note, SaveResult, Snapshot } from "airtty/client";
import type {
  Check,
  Comment,
  DiffRow,
  FileDiff,
  FileSummary,
  Identity,
  LoginResult,
  MergeReadiness,
  OperationResult,
  PublishResult,
  PullDetail,
  PullState,
  PullSummary,
  Repo,
  Review,
  Role,
  Side,
  Verdict,
} from "../components/model";
import { CHECK_NAMES, durationOf, statusOf, streamLog, type CheckRow } from "./ci";
import { diffRows, languageOf, stats, unifiedDiff } from "./diff";
import { BRANCHES, PULLS, REPOS, USERS, at } from "./seed";

export const DEMO_PIN = "forge";
const SESSION_MS = 12 * 60 * 60_000;
const MAX_BODY = 4000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The authenticated caller, resolved by `server/auth.ts` from the bearer. */
export type Actor = Identity & { sessionId: string };
export type ForgeOptions = {
  now?: () => number;
  /** Multiplies simulated CI durations; 0 finishes every check immediately. */
  ciScale?: number;
  /** Transport correlation for the audit trail (`getCallId()` in the Server). */
  callId?: () => string | undefined;
};
/** Invalid arguments: a Client bug or a forged call, never an expected business outcome. */
export class InvalidRequest extends Error {}

type PullRow = {
  id: number;
  repo: string;
  number: number;
  title: string;
  author: string;
  state: PullState;
  head_branch: string;
  base_branch: string;
  revision: number;
  description: string;
  description_version: number;
  merged_by: string | null;
  updated_at: number;
};
type FileRow = {
  path: string;
  language: string;
  before: string;
  after: string;
  patch: string;
  additions: number;
  deletions: number;
};

const text = (value: unknown, name: string, max: number) => {
  if (typeof value !== "string" || value.length > max) throw new InvalidRequest(`Invalid ${name}`);
  return value;
};
const integer = (value: unknown, name: string) => {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new InvalidRequest(`Invalid ${name}`);
  return value as number;
};
const operationId = (value: unknown) => {
  if (typeof value !== "string" || !UUID.test(value)) throw new InvalidRequest("Invalid operation");
  return value;
};
const snapshotOf = (value: unknown): Snapshot => {
  if (!value || typeof value !== "object") throw new InvalidRequest("Invalid snapshot");
  const s = value as Record<string, unknown>;
  return {
    id: text(s.id, "document", 300),
    value: text(s.value, "value", 20_000),
    version: integer(s.version, "version"),
    revision: integer(s.revision, "revision"),
    operationId: operationId(s.operationId),
  };
};

export const descriptionId = (pullId: number) => `pr:${pullId}:description`;
export const conversationSlot = (pullId: number) => `composer:conversation:${pullId}`;
export const lineSlot = (
  pullId: number,
  revision: number,
  side: Side,
  line: number,
  path: string,
) => `composer:line:${pullId}:${revision}:${side}:${line}:${path}`;
export const newPullSlot = (repo: string) => `composer:new-pull:${repo}`;

export function createForge(db: Database, options: ForgeOptions = {}) {
  const now = options.now ?? Date.now;
  const ciScale = options.ciScale ?? 1;

  function seed() {
    if (db.query("SELECT 1 FROM users LIMIT 1").get()) return;
    db.transaction(() => {
      for (const u of USERS) db.query("INSERT INTO users VALUES(?,?,?)").run(u.id, u.name, u.role);
      for (const r of REPOS)
        db.query("INSERT INTO repos VALUES(?,?,?)").run(r.slug, r.description, "main");
      for (const b of BRANCHES) {
        db.query("INSERT INTO branches VALUES(?,?,?)").run(b.repo, b.name, b.author);
        for (const f of b.files)
          db.query("INSERT INTO branch_files VALUES(?,?,?,?,?)").run(
            b.repo,
            b.name,
            f.path,
            f.before,
            f.after,
          );
      }
      for (const p of PULLS) {
        const created = at(p.created);
        const { lastInsertRowid } = db
          .query(
            "INSERT INTO pulls(repo,number,title,author,state,head_branch,base_branch,revision,description,description_version,merged_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,?,1,?,?,?)",
          )
          .run(
            p.repo,
            p.number,
            p.title,
            p.author,
            p.state,
            p.head,
            "main",
            p.description,
            p.mergedBy ?? null,
            created,
            created,
          );
        const pullId = Number(lastInsertRowid);
        insertFiles(pullId, 1, p.files);
        for (const name of CHECK_NAMES)
          db.query(
            "INSERT INTO checks(pull_id,revision,name,attempt,started_at,fail_until) VALUES(?,1,?,1,?,?)",
          ).run(pullId, name, created, p.failing?.[name] ?? 0);
        const target = `${p.repo}#${p.number}`;
        const history = [{ actor: p.author, action: "open pull request", at: created }];
        for (const r of p.reviews ?? []) {
          db.query(
            "INSERT INTO reviews(pull_id,reviewer,verdict,revision,created_at) VALUES(?,?,?,1,?)",
          ).run(pullId, r.reviewer, r.verdict, at(r.at));
          history.push({
            actor: r.reviewer,
            action: r.verdict === "approve" ? "approve" : "request changes",
            at: at(r.at),
          });
        }
        for (const c of p.comments ?? []) {
          db.query(
            "INSERT INTO comments(pull_id,author,body,path,side,line,revision,created_at) VALUES(?,?,?,?,?,?,1,?)",
          ).run(pullId, c.author, c.body, c.path ?? null, c.side ?? null, c.line ?? null, at(c.at));
          history.push({
            actor: c.author,
            action: c.path ? `comment ${c.path}:${c.line}` : "comment",
            at: at(c.at),
          });
        }
        if (p.mergedBy)
          history.push({ actor: p.mergedBy, action: "merge", at: created + 3_600_000 });
        for (const h of history)
          db.query(
            "INSERT INTO audit(actor,action,target,call_id,operation_id,at) VALUES(?,?,?,NULL,NULL,?)",
          ).run(h.actor, h.action, target, h.at);
      }
    })();
  }

  function insertFiles(
    pullId: number,
    revision: number,
    files: { path: string; before: string; after: string; patch?: string }[],
  ) {
    for (const f of files) {
      const patch = f.patch ?? unifiedDiff(f.path, f.before, f.after);
      const { additions, deletions } = stats(patch);
      db.query("INSERT INTO pull_files VALUES(?,?,?,?,?,?,?,?,?)").run(
        pullId,
        revision,
        f.path,
        languageOf(f.path),
        f.before,
        f.after,
        patch,
        additions,
        deletions,
      );
    }
  }

  // ---- Operation ledger and audit -------------------------------------------------

  function audit(actor: string, action: string, target: string, operation?: string) {
    db.query(
      "INSERT INTO audit(actor,action,target,call_id,operation_id,at) VALUES(?,?,?,?,?,?)",
    ).run(actor, action, target, options.callId?.() ?? null, operation ?? null, now());
  }
  /** Runs `work` once per (actor, operation): a retried or resolved call returns the stored result. */
  function once<T>(actor: string, id: string, kind: string, work: () => T): T {
    return db
      .transaction(() => {
        const previous = db
          .query<{ result: string }, [string, string]>(
            "SELECT result FROM operations WHERE actor=? AND id=?",
          )
          .get(actor, id);
        if (previous) return JSON.parse(previous.result) as T;
        const result = work();
        db.query("INSERT INTO operations VALUES(?,?,?,?,?)").run(
          actor,
          id,
          kind,
          JSON.stringify(result),
          now(),
        );
        return result;
      })
      .immediate();
  }
  function operation(actor: Actor, id: unknown): unknown {
    const row = db
      .query<{ result: string }, [string, string]>(
        "SELECT result FROM operations WHERE actor=? AND id=?",
      )
      .get(actor.id, operationId(id));
    return row ? JSON.parse(row.result) : null;
  }

  // ---- Accounts ------------------------------------------------------------------

  const hash = (token: string) => new Bun.CryptoHasher("sha256").update(token).digest("hex");
  function identity(userId: string): Identity | null {
    return db.query<Identity, [string]>("SELECT id,name,role FROM users WHERE id=?").get(userId);
  }
  function login(user: unknown, pin: unknown): LoginResult {
    const id = text(user, "user", 40).trim().toLowerCase();
    const code = text(pin, "pin", 40).trim();
    const found = identity(id);
    if (!found || code !== DEMO_PIN) return { ok: false, error: "Unknown user or wrong PIN" };
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    db.query("INSERT INTO sessions VALUES(?,?,?,?,NULL)").run(
      hash(token),
      found.id,
      now(),
      now() + SESSION_MS,
    );
    audit(found.id, "login", found.id);
    return { ok: true, token, identity: found };
  }
  function authenticate(token: string | undefined): Actor | null {
    if (!token || token.length > 100) return null;
    const sessionId = hash(token);
    const row = db
      .query<Identity, [string, number]>(
        "SELECT u.id,u.name,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>?",
      )
      .get(sessionId, now());
    return row ? { ...row, sessionId } : null;
  }
  function logout(actor: Actor) {
    db.query("UPDATE sessions SET revoked_at=? WHERE token_hash=?").run(now(), actor.sessionId);
    audit(actor.id, "logout", actor.id);
  }

  // ---- Reads -----------------------------------------------------------------------

  function repos(): Repo[] {
    return db
      .query<Repo, []>(
        "SELECT r.slug, r.description, (SELECT COUNT(*) FROM pulls p WHERE p.repo=r.slug AND p.state='open') AS openPulls FROM repos r ORDER BY r.slug",
      )
      .all();
  }
  function repo(slug: string) {
    return repos().find((r) => r.slug === slug) ?? null;
  }
  const SUMMARY = `SELECT p.repo, p.number, p.title, p.author, p.state, p.revision, p.updated_at AS updatedAt,
      COALESCE((SELECT SUM(additions) FROM pull_files f WHERE f.pull_id=p.id AND f.revision=p.revision),0) AS additions,
      COALESCE((SELECT SUM(deletions) FROM pull_files f WHERE f.pull_id=p.id AND f.revision=p.revision),0) AS deletions,
      (SELECT COUNT(*) FROM comments c WHERE c.pull_id=p.id) AS comments
    FROM pulls p`;
  function pulls(slug: string, state: PullState | "all" = "all"): PullSummary[] {
    return db
      .query<PullSummary, [string, string]>(
        `${SUMMARY} WHERE p.repo=?1 AND (?2='all' OR p.state=?2) ORDER BY p.number DESC`,
      )
      .all(slug, state);
  }
  function inbox(actor: Actor) {
    const open = db
      .query<PullSummary & { id: number }, []>(
        `${SUMMARY.replace("SELECT", "SELECT p.id,")} WHERE p.state='open' ORDER BY p.updated_at DESC`,
      )
      .all();
    const reviewed = (pull: PullSummary & { id: number }) =>
      !!db
        .query("SELECT 1 FROM reviews WHERE pull_id=? AND reviewer=? AND revision=?")
        .get(pull.id, actor.id, pull.revision);
    const strip = ({ id: _id, ...rest }: PullSummary & { id: number }): PullSummary => rest;
    return {
      reviewRequested: open
        .filter((p) => actor.role !== "reader" && p.author !== actor.id && !reviewed(p))
        .map(strip),
      mine: open.filter((p) => p.author === actor.id).map(strip),
      following: open
        .filter((p) => actor.role === "reader" || (p.author !== actor.id && reviewed(p)))
        .map(strip),
    };
  }
  function pullRow(slug: string, number: number) {
    return db
      .query<PullRow, [string, number]>("SELECT * FROM pulls WHERE repo=? AND number=?")
      .get(slug, number);
  }
  function pull(slug: string, number: number): PullDetail | null {
    const row = pullRow(slug, number);
    if (!row) return null;
    const summary = pulls(slug).find((p) => p.number === number);
    if (!summary) return null;
    return {
      ...summary,
      id: row.id,
      headBranch: row.head_branch,
      baseBranch: row.base_branch,
      mergedBy: row.merged_by,
    };
  }
  function files(pullId: number, revision: number): FileSummary[] {
    return db
      .query<FileSummary, [number, number]>(
        "SELECT path, language, additions, deletions FROM pull_files WHERE pull_id=? AND revision=? ORDER BY path",
      )
      .all(pullId, revision);
  }
  function fileDiff(pullId: number, revision: number, path: string): FileDiff | null {
    const row = db
      .query<FileRow, [number, number, string]>(
        "SELECT * FROM pull_files WHERE pull_id=? AND revision=? AND path=?",
      )
      .get(pullId, revision, path);
    if (!row) return null;
    const rows: DiffRow[] = diffRows(row.patch);
    return {
      path: row.path,
      language: row.language,
      additions: row.additions,
      deletions: row.deletions,
      patch: row.patch,
      rows,
    };
  }
  function comments(pullId: number): Comment[] {
    return db
      .query<Comment, [number]>(
        "SELECT id, author, body, path, side, line, revision, created_at AS createdAt FROM comments WHERE pull_id=? ORDER BY created_at, id",
      )
      .all(pullId);
  }
  function reviews(pullId: number): Review[] {
    return db
      .query<Review, [number]>(
        "SELECT reviewer, verdict, revision, created_at AS createdAt FROM reviews WHERE pull_id=? ORDER BY created_at, id",
      )
      .all(pullId);
  }
  function checkRows(pullId: number, revision: number) {
    return db
      .query<CheckRow, [number, number]>(
        "SELECT id, name, attempt, started_at, fail_until FROM checks WHERE pull_id=? AND revision=? ORDER BY id",
      )
      .all(pullId, revision);
  }
  function checks(pullId: number, revision: number): Check[] {
    const t = now();
    return checkRows(pullId, revision).map((c) => ({
      id: c.id,
      name: c.name,
      attempt: c.attempt,
      status: statusOf(c, t, ciScale),
      durationMs: durationOf(c, ciScale),
    }));
  }
  function checkLog(checkId: number) {
    const row = db
      .query<CheckRow, [number]>(
        "SELECT id, name, attempt, started_at, fail_until FROM checks WHERE id=?",
      )
      .get(checkId);
    if (!row) throw new InvalidRequest("Unknown check");
    return streamLog(row, ciScale, now);
  }
  function readiness(pullId: number): MergeReadiness {
    const row = db.query<PullRow, [number]>("SELECT * FROM pulls WHERE id=?").get(pullId);
    if (!row) throw new InvalidRequest("Unknown pull request");
    const latest = new Map<string, Verdict>();
    for (const r of reviews(pullId))
      if (r.revision === row.revision) latest.set(r.reviewer, r.verdict);
    const approvals = [...latest].filter(([, v]) => v === "approve").map(([who]) => who);
    const changesRequested = [...latest].filter(([, v]) => v === "changes").map(([who]) => who);
    const statuses = checks(pullId, row.revision).map((c) => c.status);
    const reasons: string[] = [];
    if (row.state !== "open") reasons.push(`Pull request is ${row.state}`);
    if (!approvals.length) reasons.push(`No approval on revision ${row.revision}`);
    if (changesRequested.length)
      reasons.push(`Changes requested by ${changesRequested.join(", ")}`);
    if (statuses.some((s) => s === "failure")) reasons.push("A check failed");
    else if (statuses.some((s) => s !== "success")) reasons.push("Checks still running");
    return { approvals, changesRequested, checks: statuses, canMerge: !reasons.length, reasons };
  }
  /** Branches of `slug` without a pull request yet. */
  function availableBranches(slug: string) {
    return db
      .query<{ name: string; author: string; files: number }, [string]>(
        "SELECT b.name, b.author, (SELECT COUNT(*) FROM branch_files f WHERE f.repo=b.repo AND f.branch=b.name) AS files FROM branches b WHERE b.repo=? AND NOT EXISTS (SELECT 1 FROM pulls p WHERE p.repo=b.repo AND p.head_branch=b.name) ORDER BY b.name",
      )
      .all(slug);
  }
  function activity(limit = 12) {
    return db
      .query<{ actor: string; action: string; target: string; at: number }, [number]>(
        "SELECT actor, action, target, at FROM audit ORDER BY at DESC, id DESC LIMIT ?",
      )
      .all(limit);
  }

  // ---- Documents: description and composers ----------------------------------------

  function descriptionNote(pullId: number): Note {
    const row = db.query<PullRow, [number]>("SELECT * FROM pulls WHERE id=?").get(pullId);
    if (!row) throw new InvalidRequest("Unknown pull request");
    return {
      id: descriptionId(pullId),
      title: `#${row.number} description`,
      value: row.description,
      version: row.description_version,
    };
  }
  function composerVersion(actor: string, slot: string) {
    return (
      db
        .query<{ version: number }, [string, string]>(
          "SELECT version FROM composers WHERE user_id=? AND slot=?",
        )
        .get(actor, slot)?.version ?? 0
    );
  }
  function composerNote(actor: Actor, slot: string): Note {
    return { id: slot, title: "", value: "", version: composerVersion(actor.id, slot) };
  }
  /** Composer versions of every slot this actor used on `pullId`, for line composers opened later. */
  function composerVersions(actor: Actor, pullId: number): Record<string, number> {
    const rows = db
      .query<{ slot: string; version: number }, [string, string]>(
        "SELECT slot, version FROM composers WHERE user_id=? AND slot LIKE ?",
      )
      .all(actor.id, `composer:line:${pullId}:%`);
    return Object.fromEntries(rows.map((r) => [r.slot, r.version]));
  }
  const canWrite = (actor: Actor) => actor.role !== "reader";

  function saveDescription(actor: Actor, input: unknown): SaveResult {
    const snapshot = snapshotOf(input);
    const match = /^pr:(\d+):description$/.exec(snapshot.id);
    if (!match) throw new InvalidRequest("Invalid document");
    const pullId = Number(match[1]);
    return once(actor.id, snapshot.operationId, "description", () => {
      const fail = (error: string): SaveResult => ({
        ok: false,
        error,
        operationId: snapshot.operationId,
      });
      const row = db.query<PullRow, [number]>("SELECT * FROM pulls WHERE id=?").get(pullId);
      if (!row) return fail("Pull request not found");
      if (row.author !== actor.id && actor.role !== "maintainer")
        return fail("Only the author or a maintainer can edit the description");
      if (row.description_version !== snapshot.version)
        return fail("Description changed on the Server: discard to reload");
      const value = snapshot.value.trim();
      if (!value || value.length > MAX_BODY) return fail(`Enter 1–${MAX_BODY} characters`);
      db.query(
        "UPDATE pulls SET description=?, description_version=description_version+1, updated_at=? WHERE id=?",
      ).run(value, now(), pullId);
      audit(actor.id, "edit description", `${row.repo}#${row.number}`, snapshot.operationId);
      return { ok: true, note: descriptionNote(pullId), operationId: snapshot.operationId };
    });
  }

  /** Publishes a composer: a comment, a line comment or a new pull request. */
  function publish(
    actor: Actor,
    input: unknown,
    extra: { title?: unknown; branch?: unknown } = {},
  ): PublishResult {
    const snapshot = snapshotOf(input);
    const slot = snapshot.id;
    const kind = /^composer:(conversation|line|new-pull):/.exec(slot)?.[1];
    if (!kind) throw new InvalidRequest("Invalid composer");
    const title = kind === "new-pull" ? text(extra.title, "title", 200).trim() : "";
    const branch = kind === "new-pull" ? text(extra.branch, "branch", 200) : "";
    return once(actor.id, snapshot.operationId, `publish ${kind}`, () => {
      const fail = (error: string): PublishResult => ({
        ok: false,
        error,
        operationId: snapshot.operationId,
      });
      if (!canWrite(actor)) return fail("Readers cannot publish");
      const version = composerVersion(actor.id, slot);
      if (version !== snapshot.version)
        return fail("This composer was published elsewhere: discard to continue");
      const body = snapshot.value.trim();
      if (!body || body.length > MAX_BODY) return fail(`Enter 1–${MAX_BODY} characters`);
      let number: number | undefined;
      if (kind === "new-pull") {
        const repo = slot.slice("composer:new-pull:".length);
        if (title.length < 3) return fail("Title needs at least 3 characters");
        const owned = db.query("SELECT 1 FROM branches WHERE repo=? AND name=?").get(repo, branch);
        if (!owned) return fail("Unknown branch");
        if (db.query("SELECT 1 FROM pulls WHERE repo=? AND head_branch=?").get(repo, branch))
          return fail("This branch already has a pull request");
        number =
          db
            .query<{ n: number }, [string]>(
              "SELECT COALESCE(MAX(number),0)+1 AS n FROM pulls WHERE repo=?",
            )
            .get(repo)?.n ?? 1;
        const { lastInsertRowid } = db
          .query(
            "INSERT INTO pulls(repo,number,title,author,state,head_branch,base_branch,revision,description,description_version,merged_by,created_at,updated_at) VALUES(?,?,?,?,'open',?,'main',1,?,1,NULL,?,?)",
          )
          .run(repo, number, title, actor.id, branch, body, now(), now());
        const pullId = Number(lastInsertRowid);
        insertFiles(
          pullId,
          1,
          db
            .query<{ path: string; before: string; after: string }, [string, string]>(
              "SELECT path, before, after FROM branch_files WHERE repo=? AND branch=?",
            )
            .all(repo, branch),
        );
        startChecks(pullId, 1, 0);
        audit(actor.id, "open pull request", `${repo}#${number}`, snapshot.operationId);
      } else {
        const parts = slot.split(":");
        const pullId = Number(parts[2]);
        const row = db.query<PullRow, [number]>("SELECT * FROM pulls WHERE id=?").get(pullId);
        if (!row) return fail("Pull request not found");
        let anchor: { path: string; side: Side; line: number } | null = null;
        if (kind === "line") {
          const revision = Number(parts[3]),
            side = parts[4],
            line = Number(parts[5]),
            path = parts.slice(6).join(":");
          if (side !== "old" && side !== "new") throw new InvalidRequest("Invalid side");
          if (revision !== row.revision)
            return fail(
              `Revision ${row.revision} was pushed: this line may have moved. Discard and comment again`,
            );
          const diff = fileDiff(pullId, revision, path);
          if (!diff?.rows.some((r) => r[side] === line))
            return fail("This line is not part of the diff");
          anchor = { path, side, line };
        }
        db.query(
          "INSERT INTO comments(pull_id,author,body,path,side,line,revision,created_at) VALUES(?,?,?,?,?,?,?,?)",
        ).run(
          pullId,
          actor.id,
          body,
          anchor?.path ?? null,
          anchor?.side ?? null,
          anchor?.line ?? null,
          row.revision,
          now(),
        );
        db.query("UPDATE pulls SET updated_at=? WHERE id=?").run(now(), pullId);
        audit(
          actor.id,
          anchor ? `comment ${anchor.path}:${anchor.line}` : "comment",
          `${row.repo}#${row.number}`,
          snapshot.operationId,
        );
      }
      db.query(
        "INSERT INTO composers VALUES(?,?,1) ON CONFLICT(user_id,slot) DO UPDATE SET version=version+1",
      ).run(actor.id, slot);
      return {
        ok: true,
        note: composerNote(actor, slot),
        operationId: snapshot.operationId,
        number,
      };
    });
  }

  // ---- Operations: review, merge, rerun --------------------------------------------

  type Target = { repo: unknown; number: unknown; revision?: unknown; operationId: unknown };
  function target(input: Target) {
    return {
      repo: text(input.repo, "repo", 100),
      number: integer(input.number, "number"),
      revision: input.revision === undefined ? undefined : integer(input.revision, "revision"),
      operationId: operationId(input.operationId),
    };
  }

  function review(actor: Actor, input: Target & { verdict: unknown }): OperationResult {
    const t = target(input);
    const verdict = input.verdict;
    if (verdict !== "approve" && verdict !== "changes") throw new InvalidRequest("Invalid verdict");
    return once(actor.id, t.operationId, "review", () => {
      const fail = (error: string): OperationResult => ({
        ok: false,
        error,
        operationId: t.operationId,
      });
      const row = pullRow(t.repo, t.number);
      if (!row) return fail("Pull request not found");
      if (!canWrite(actor)) return fail("Readers cannot review");
      if (row.author === actor.id) return fail("Authors cannot review their own pull request");
      if (row.state !== "open") return fail(`Pull request is ${row.state}`);
      if (row.revision !== t.revision)
        return fail(`Revision ${row.revision} was pushed: review it first`);
      db.query(
        "INSERT INTO reviews(pull_id,reviewer,verdict,revision,created_at) VALUES(?,?,?,?,?)",
      ).run(row.id, actor.id, verdict, row.revision, now());
      db.query("UPDATE pulls SET updated_at=? WHERE id=?").run(now(), row.id);
      audit(
        actor.id,
        verdict === "approve" ? "approve" : "request changes",
        `${row.repo}#${row.number}`,
        t.operationId,
      );
      return {
        ok: true,
        operationId: t.operationId,
        message: verdict === "approve" ? "Approved" : "Changes requested",
      };
    });
  }

  function merge(actor: Actor, input: Target): OperationResult {
    const t = target(input);
    return once(actor.id, t.operationId, "merge", () => {
      const fail = (error: string): OperationResult => ({
        ok: false,
        error,
        operationId: t.operationId,
      });
      const row = pullRow(t.repo, t.number);
      if (!row) return fail("Pull request not found");
      if (actor.role !== "maintainer") return fail("Only maintainers can merge");
      if (row.revision !== t.revision)
        return fail(`Revision ${row.revision} was pushed: review it first`);
      const ready = readiness(row.id);
      if (!ready.canMerge) return fail(ready.reasons.join(" · "));
      db.query("UPDATE pulls SET state='merged', merged_by=?, updated_at=? WHERE id=?").run(
        actor.id,
        now(),
        row.id,
      );
      audit(actor.id, "merge", `${row.repo}#${row.number}`, t.operationId);
      return {
        ok: true,
        operationId: t.operationId,
        message: `Merged #${row.number} into ${row.base_branch}`,
      };
    });
  }

  function startChecks(pullId: number, revision: number, queueMs: number) {
    for (const name of CHECK_NAMES)
      db.query(
        "INSERT INTO checks(pull_id,revision,name,attempt,started_at,fail_until) VALUES(?,?,?,1,?,0) ON CONFLICT(pull_id,revision,name) DO UPDATE SET attempt=attempt+1, started_at=excluded.started_at",
      ).run(pullId, revision, name, now() + Math.round(queueMs * ciScale));
  }

  function rerun(actor: Actor, input: Target): OperationResult {
    const t = target(input);
    return once(actor.id, t.operationId, "rerun", () => {
      const fail = (error: string): OperationResult => ({
        ok: false,
        error,
        operationId: t.operationId,
      });
      const row = pullRow(t.repo, t.number);
      if (!row) return fail("Pull request not found");
      if (!canWrite(actor)) return fail("Readers cannot run checks");
      if (row.state !== "open") return fail(`Pull request is ${row.state}`);
      const rows = checkRows(row.id, row.revision);
      if (!rows.length) return fail("No checks for this revision");
      if (
        rows.some(
          (c) =>
            statusOf(c, now(), ciScale) === "running" || statusOf(c, now(), ciScale) === "queued",
        )
      )
        return fail("Checks are still running");
      db.query(
        "UPDATE checks SET attempt=attempt+1, started_at=? WHERE pull_id=? AND revision=?",
      ).run(now() + Math.round(300 * ciScale), row.id, row.revision);
      audit(actor.id, "rerun checks", `${row.repo}#${row.number}`, t.operationId);
      return {
        ok: true,
        operationId: t.operationId,
        message: `Checks restarted (attempt ${rows[0].attempt + 1})`,
      };
    });
  }

  // ---- Second operator (script and tests only; never exposed as a Server Function) --

  const operator = {
    /** Pushes a new revision: previous approvals and line composers become stale. */
    push(slug: string, number: number, by = "bob") {
      return db
        .transaction(() => {
          const row = pullRow(slug, number);
          if (!row || row.state !== "open") throw new InvalidRequest("Pull request is not open");
          const previous = db
            .query<FileRow, [number, number]>(
              "SELECT * FROM pull_files WHERE pull_id=? AND revision=? ORDER BY path",
            )
            .all(row.id, row.revision);
          const next = row.revision + 1;
          insertFiles(
            row.id,
            next,
            previous.map((f, index) =>
              index === 0
                ? {
                    path: f.path,
                    before: f.before,
                    after: `// Revision ${next}: address review feedback\n${f.after}`,
                  }
                : { path: f.path, before: f.before, after: f.after, patch: f.patch },
            ),
          );
          db.query("UPDATE pulls SET revision=?, updated_at=? WHERE id=?").run(next, now(), row.id);
          startChecks(row.id, next, 500);
          audit(by, `push revision ${next}`, `${slug}#${number}`);
          return next;
        })
        .immediate();
    },
    editDescription(slug: string, number: number, description: string, by = "alice") {
      const row = pullRow(slug, number);
      if (!row) throw new InvalidRequest("Unknown pull request");
      db.query(
        "UPDATE pulls SET description=?, description_version=description_version+1, updated_at=? WHERE id=?",
      ).run(description, now(), row.id);
      audit(by, "edit description", `${slug}#${number}`);
      return row.description_version + 1;
    },
    /** Arms a lost response: the next committed operation of `kind` fails after commit. */
    armFault(kind: "merge" | "review" | "publish") {
      db.query("INSERT OR IGNORE INTO faults VALUES(?)").run(kind);
    },
  };
  function consumeFault(kind: string) {
    return db.query("DELETE FROM faults WHERE kind=?").run(kind).changes > 0;
  }
  function count(table: "comments" | "reviews" | "pulls", where = "1=1") {
    return (
      db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get()?.n ?? 0
    );
  }

  seed();
  return {
    /** The Forge clock: pages read time from here, never during a Client render. */
    now,
    login,
    authenticate,
    logout,
    identity,
    repos,
    repo,
    pulls,
    inbox,
    pull,
    files,
    fileDiff,
    comments,
    reviews,
    checks,
    checkLog,
    readiness,
    availableBranches,
    activity,
    descriptionNote,
    composerNote,
    composerVersions,
    saveDescription,
    publish,
    review,
    merge,
    rerun,
    operation,
    consumeFault,
    operator,
    count,
    insertFiles,
    startChecks,
    db,
  };
}
export type Forge = ReturnType<typeof createForge>;
export type { Role };
