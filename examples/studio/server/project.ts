/**
 * A studio project: the directory the harness writes, created from the template, and the
 * git repository studio keeps in it, one commit per revision (examples/studio/DESIGN.md, 2.5).
 * Git runs with an identity and settings of its own: never the user's name, hooks or
 * signing key. `.luciole-studio/` holds what studio keeps beside the code (builds, the
 * project's publisher key, the lock); it is ignored by git and closed to the harness.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { frameworkModules } from "luciole/dev";
import { splitPatch } from "@luciole/harness/diff";
import type { FilePatch } from "@luciole/harness/model";
import { TEMPLATE } from "./template.gen";

/** Beside the code, ignored by git, closed to the harness. */
export const STATE_DIRECTORY = ".luciole-studio";
const PRIVATE_DIRECTORY = 0o700;
const GIT_IDENTITY = [
  "-c",
  "user.name=studio",
  "-c",
  "user.email=studio@localhost",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "init.defaultBranch=main",
];
const REVISION = /^studio: r(\d+)(?: · (.*))?$/;
// A prompt in a commit subject: its first line, this long.
const SUBJECT_LENGTH = 72;
// `git status --porcelain`: two status letters and a space, then the path.
const STATUS_WIDTH = 3;
const MS_PER_SECOND = 1000;

export type Revision = { number: number; hash: string; summary: string; at: number };

/** Where projects named by `--project` live: `$XDG_DATA_HOME/luciole/studio/<name>`. */
export const projectsRoot = (env: NodeJS.ProcessEnv = process.env) =>
  join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "luciole", "studio");

/** The framework's packages, which a project resolves through its node_modules link. */
function packages() {
  return frameworkModules(dirname(Bun.resolveSync("luciole/client", import.meta.dir)));
}

// Asynchronous: Bun 1.4's spawnSync can lose a child's exit and spin forever at 100 % CPU
// (oven-sh/bun#34069), and studio runs git at every turn.
async function git(directory: string, args: readonly string[], input?: string) {
  const child = Bun.spawn(["git", ...GIT_IDENTITY, "-C", directory, ...args], {
    stdin: input === undefined ? "ignore" : Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status !== 0) throw new Error(`git ${args[0] ?? ""}: ${(stderr || stdout).trim()}`);
  return stdout;
}
const hasGit = () => Bun.which("git") !== null;

/** Whether `pid` is a live process (the lock's owner). */
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class Project {
  readonly directory: string;
  readonly state: string;
  readonly name: string;
  private readonly lock: string;
  private constructor(directory: string) {
    this.directory = directory;
    this.name = directory.split(sep).at(-1) ?? "app";
    this.state = join(directory, STATE_DIRECTORY);
    this.lock = join(this.state, "studio.pid");
  }

  /**
   * Opens the project at `directory`: an empty (or missing) one is created from the
   * template as revision r0; a studio project is reopened; any other directory is
   * refused, never written into.
   */
  static async open(directory: string): Promise<Project> {
    if (!hasGit()) throw new Error("studio keeps revisions with git: install git first");
    const project = new Project(resolve(directory));
    const entries = existsSync(project.directory) ? readdirSync(project.directory) : [];
    const known = existsSync(project.state);
    if (entries.length && !known)
      throw new Error(
        `${project.directory} is not a studio project: open an empty directory, or name a new project with --project`,
      );
    mkdirSync(project.state, { recursive: true, mode: PRIVATE_DIRECTORY });
    project.acquire();
    if (!known) await project.create();
    else await project.reread();
    project.link();
    return project;
  }

  /** One studio per project: two harnesses writing the same files contradict each other. */
  private acquire() {
    if (existsSync(this.lock)) {
      const pid = Number(readFileSync(this.lock, "utf8"));
      if (pid !== process.pid && Number.isInteger(pid) && alive(pid))
        throw new Error(`${this.directory} is open in another studio (pid ${pid})`);
    }
    writeFileSync(this.lock, String(process.pid));
    process.on("exit", () => this.release());
  }
  release() {
    try {
      if (readFileSync(this.lock, "utf8") === String(process.pid)) rmSync(this.lock);
    } catch {}
  }

  private async create() {
    for (const [file, content] of Object.entries(TEMPLATE)) {
      const path = join(this.directory, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    await git(this.directory, ["init", "-q"]);
    await this.commit("template");
  }

  /** node_modules → the framework's packages: nothing to install, nothing to fetch. */
  private link() {
    const link = join(this.directory, "node_modules");
    if (!existsSync(link)) symlinkSync(packages(), link, "dir");
  }

  /** A directory of `.luciole-studio/` for studio's own files, private to the user. */
  privateDirectory(...path: string[]) {
    const directory = join(this.state, ...path);
    mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY });
    chmodSync(directory, PRIVATE_DIRECTORY);
    return directory;
  }

  /** The app's data directory: the one place its confined Server writes. */
  data() {
    const directory = join(this.directory, "data");
    mkdirSync(directory, { recursive: true });
    return directory;
  }

  /** Files changed since the last revision: path → new content, `null` when deleted. */
  async changes(): Promise<Map<string, string | null>> {
    const out = await git(this.directory, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    const changes = new Map<string, string | null>();
    const fields = out.split("\0").filter(Boolean);
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i] ?? "";
      const status = field.slice(0, 2);
      const path = field.slice(STATUS_WIDTH);
      // A rename is followed by its source: gone, like a deletion.
      if (status.startsWith("R")) {
        const source = fields[++i];
        if (source) changes.set(source, null);
      }
      const file = join(this.directory, path);
      changes.set(path, existsSync(file) ? readFileSync(file, "utf8") : null);
    }
    return changes;
  }

  /** Puts `paths` back as the last revision has them: added files go, others return. */
  async discard(paths: readonly string[]) {
    const tracked = new Set(
      (await git(this.directory, ["ls-tree", "-r", "--name-only", "-z", "HEAD"])).split("\0"),
    );
    const known = paths.filter((path) => tracked.has(path));
    if (known.length) await git(this.directory, ["checkout", "HEAD", "--", ...known]);
    for (const path of paths.filter((p) => !tracked.has(p)))
      rmSync(join(this.directory, path), { force: true });
  }

  /** Commits everything as the next revision; its number. */
  async commit(summary: string): Promise<number> {
    const number = (this.known[0]?.number ?? -1) + 1;
    const line = summary.split("\n")[0]?.slice(0, SUBJECT_LENGTH) ?? "";
    await git(this.directory, ["add", "-A"]);
    await git(
      this.directory,
      ["commit", "-q", "--allow-empty", "-F", "-"],
      `studio: r${number} · ${line}\n`,
    );
    await this.reread();
    return number;
  }

  /** The revisions, newest first: as read at the last commit (nothing else writes them). */
  revisions(): Revision[] {
    return this.known;
  }
  private known: Revision[] = [];

  private async reread() {
    let log = "";
    try {
      log = await git(this.directory, ["log", "--format=%H%x00%s%x00%ct"]);
    } catch {
      this.known = [];
      return;
    }
    this.known = log
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        const [hash = "", subject = "", seconds = "0"] = line.split("\0");
        const match = REVISION.exec(subject);
        return match
          ? [
              {
                number: Number(match[1]),
                hash,
                summary: match[2] ?? "",
                at: Number(seconds) * MS_PER_SECOND,
              },
            ]
          : [];
      });
  }

  private revision(number: number) {
    const found = this.revisions().find((r) => r.number === number);
    if (!found) throw new Error(`No revision r${number}`);
    return found;
  }

  /** The files of revision `number` in the working tree, committed as a new revision. */
  async restore(number: number): Promise<number> {
    const { hash } = this.revision(number);
    await git(this.directory, ["read-tree", "-u", "--reset", hash]);
    return this.commit(`restored r${number}`);
  }

  /** What revision `number` changed, one patch per file. */
  async patch(number: number): Promise<FilePatch[]> {
    const { hash } = this.revision(number);
    return splitPatch(await git(this.directory, ["show", "--format=", "--no-color", hash]));
  }
}
