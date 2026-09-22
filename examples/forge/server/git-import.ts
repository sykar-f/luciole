import type { Forge } from "./forge";
import { CHECK_NAMES } from "./ci";
import { SEED_EPOCH } from "./seed";

const MAX_FILES = 40;
const MAX_LINES = 3000;

function git(repo: string, args: string[]) {
  const result = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  return result.exitCode === 0 ? result.stdout.toString() : null;
}
const tooLarge = (text: string) => text.split("\n").length > MAX_LINES;

/**
 * Imports the last `count` commits of a local git checkout as a repository whose pull
 * requests carry real patches. Runs once: an existing repository is left untouched.
 * Server-only by construction: the Client bundle never contains git access.
 */
export function importGitRepository(forge: Forge, path: string, slug: string, count: number) {
  if (forge.repo(slug)) return 0;
  const log = git(path, ["log", "--no-merges", `-n${count}`, "--format=%H%x1f%s%x1f%b%x1e"]);
  if (log === null) throw new Error(`Not a git checkout: ${path}`);
  const commits = log
    .split("\x1e")
    .map((entry) => entry.trim().split("\x1f"))
    .filter((parts) => parts.length === 3 && parts[0])
    .reverse();
  const { db } = forge;
  db.transaction(() => {
    db.query("INSERT INTO repos VALUES(?,?,?)").run(slug, `Imported from ${path}`, "main");
    commits.forEach(([sha, subject, body], index) => {
      if (git(path, ["rev-parse", "--verify", "-q", `${sha}^`]) === null) return;
      const numstat = git(path, ["diff-tree", "--no-commit-id", "-r", "--numstat", sha]) ?? "";
      const files = numstat
        .split("\n")
        .map((line) => line.split("\t"))
        .filter((parts) => parts.length === 3 && parts[0] !== "-")
        .slice(0, MAX_FILES)
        .flatMap(([, , file]) => {
          const before = git(path, ["show", `${sha}^:${file}`]) ?? "";
          const after = git(path, ["show", `${sha}:${file}`]) ?? "";
          if (tooLarge(before) || tooLarge(after)) return [];
          const raw = git(path, ["diff", "--no-color", `${sha}^`, sha, "--", file]) ?? "";
          const patch = raw.slice(Math.max(0, raw.indexOf("\n--- ") + 1));
          return patch.startsWith("--- ") ? [{ path: file, before, after, patch }] : [];
        });
      if (!files.length) return;
      const open = index >= commits.length - 2;
      const author = index % 2 ? "bob" : "alice";
      const created = SEED_EPOCH + index * 3_600_000;
      const number = index + 1;
      const { lastInsertRowid } = db
        .query(
          "INSERT INTO pulls(repo,number,title,author,state,head_branch,base_branch,revision,description,description_version,merged_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,?,1,?,?,?)",
        )
        .run(
          slug,
          number,
          subject.slice(0, 200),
          author,
          open ? "open" : "merged",
          `commit/${sha.slice(0, 8)}`,
          "main",
          body.trim() || `Imported commit \`${sha.slice(0, 12)}\`.`,
          open ? null : "alice",
          created,
          created,
        );
      const pullId = Number(lastInsertRowid);
      forge.insertFiles(pullId, 1, files);
      for (const name of CHECK_NAMES)
        db.query(
          "INSERT INTO checks(pull_id,revision,name,attempt,started_at,fail_until) VALUES(?,1,?,1,?,0)",
        ).run(pullId, name, created);
    });
  })();
  return commits.length;
}
