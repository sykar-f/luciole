import type { Forge } from "./forge";
import { CHECK_NAMES } from "./ci";
import { SEED_EPOCH } from "./seed";

const MAX_FILES = 40;
const MAX_LINES = 3000;
const MAX_TITLE = 200;
const HOUR_MS = 3_600_000;
// `%H %s %b` per commit, `added removed path` per numstat line.
const LOG_FIELDS = 3,
  NUMSTAT_FIELDS = 3;
const BRANCH_SHA = 8,
  TITLE_SHA = 12;

// Asynchronous: Bun 1.4's spawnSync can lose a child's exit and spin forever
// (oven-sh/bun#34069); git is run dozens of times here.
async function git(repo: string, args: string[]) {
  const child = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return code === 0 ? stdout : null;
}
const tooLarge = (text: string) => text.split("\n").length > MAX_LINES;

type ImportedFile = { path: string; before: string; after: string; patch: string };
/** The files commit `sha` changed, with their patches; none when it has no parent. */
async function filesOf(path: string, sha: string): Promise<ImportedFile[]> {
  if ((await git(path, ["rev-parse", "--verify", "-q", `${sha}^`])) === null) return [];
  const numstat = (await git(path, ["diff-tree", "--no-commit-id", "-r", "--numstat", sha])) ?? "";
  const files: ImportedFile[] = [];
  for (const [, , file] of numstat
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((parts) => parts.length === NUMSTAT_FIELDS && parts[0] !== "-")
    .slice(0, MAX_FILES)) {
    const before = (await git(path, ["show", `${sha}^:${file}`])) ?? "";
    const after = (await git(path, ["show", `${sha}:${file}`])) ?? "";
    if (tooLarge(before) || tooLarge(after)) continue;
    const raw = (await git(path, ["diff", "--no-color", `${sha}^`, sha, "--", file])) ?? "";
    const patch = raw.slice(Math.max(0, raw.indexOf("\n--- ") + 1));
    if (patch.startsWith("--- ") && file !== undefined)
      files.push({ path: file, before, after, patch });
  }
  return files;
}

/**
 * Imports the last `count` commits of a local git checkout as a repository whose pull
 * requests carry real patches. Runs once: an existing repository is left untouched.
 * Server-only by construction: the Client bundle never contains git access.
 */
export async function importGitRepository(forge: Forge, path: string, slug: string, count: number) {
  if (forge.repo(slug)) return 0;
  const log = await git(path, ["log", "--no-merges", `-n${count}`, "--format=%H%x1f%s%x1f%b%x1e"]);
  if (log === null) throw new Error(`Not a git checkout: ${path}`);
  const commits = log
    .split("\x1e")
    .map((entry) => entry.trim().split("\x1f"))
    .filter((parts) => parts.length === LOG_FIELDS && parts[0])
    .reverse();
  // Everything git says is read first: the database transaction below is synchronous.
  const changed: ImportedFile[][] = [];
  for (const [sha = ""] of commits) changed.push(await filesOf(path, sha));
  const { db } = forge;
  db.transaction(() => {
    db.query("INSERT INTO repos VALUES(?,?,?)").run(slug, `Imported from ${path}`, "main");
    commits.forEach(([sha, subject, body], index) => {
      const files = changed[index] ?? [];
      if (!files.length) return;
      const open = index >= commits.length - 2;
      const author = index % 2 ? "bob" : "alice";
      const created = SEED_EPOCH + index * HOUR_MS;
      const number = index + 1;
      const { lastInsertRowid } = db
        .query(
          "INSERT INTO pulls(repo,number,title,author,state,head_branch,base_branch,revision,description,description_version,merged_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,?,1,?,?,?)",
        )
        .run(
          slug,
          number,
          subject.slice(0, MAX_TITLE),
          author,
          open ? "open" : "merged",
          `commit/${sha.slice(0, BRANCH_SHA)}`,
          "main",
          body.trim() || `Imported commit \`${sha.slice(0, TITLE_SHA)}\`.`,
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
