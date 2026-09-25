/**
 * An app launched from a git repository (sources: ./git-source.ts).
 *
 * Each commit is checked out once in `<cache>/<hash of url>/<sha>` (a shallow, blobless
 * fetch), installed with `bun install --frozen-lockfile` and built; the build is reused
 * while the commit, its bun.lock and the framework stay the same. A branch is checked
 * with `git ls-remote` on every launch; a commit sha or a tag never moves, so it is not.
 * Offline, the last checkout of that ref is launched with a warning.
 *
 * A repository is arbitrary code, its Server included: the first time a repository (its
 * URL) is launched, its commit is shown and must be accepted before anything of it runs
 * (install scripts, bundler macros, the app). The answer is remembered by URL in
 * `<config>/trust.json`; later commits of that repository run after a short account of
 * the new commits.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import * as z from "zod/mini";
import { build } from "../build";
import { messageOf } from "../guards";
import { describeSource, type GitSource } from "./git-source";
import { withLock } from "./lock";
import { APP_NAME, type Directories } from "./paths";
import type { Confirm } from "./prompt";
import { governingLock } from "../lockfile";

const FULL_SHA = /^[0-9a-f]{40}$/;
// What a commit or a cache key reads as: enough to tell apart, short enough to read.
const SHORT_SHA = 12;
const URL_KEY = 16;
const short = (sha: string) => sha.slice(0, SHORT_SHA);

export type GitOptions = {
  directories: Pick<Directories, "git" | "config">;
  confirm: Confirm;
  /** Progress and warnings, for stderr. */
  log: (message: string) => void;
  git?: string;
  bun?: string;
  /** Builds the app in place; `airtty build` by default. */
  build?: (directory: string) => Promise<unknown>;
};

/** What the cache remembers of each ref: where it pointed, and whether it can move. */
const Refs = z.record(z.string(), z.object({ sha: z.string(), fixed: z.boolean() }));
/** `<config>/trust.json`: repositories the user accepted, with the last commit run. */
const Trust = z.record(z.string(), z.object({ sha: z.string(), at: z.string() }));
/** Next to a built app: what its build was made from. */
const Built = z.object({ lock: z.string(), framework: z.string() });

async function readJson<T>(file: string, schema: z.ZodMiniType<T>, fallback: T): Promise<T> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return fallback;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${file}: invalid JSON`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`${file}: unexpected content`);
  return parsed.data;
}
async function writeJson(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n");
  await rename(temporary, file);
}

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

const frameworkDirectory = resolve(import.meta.dir, "..");
let frameworkHash: Promise<string> | undefined;
/** The framework's sources and lockfile: a build made by another airtty is redone. */
function framework() {
  frameworkHash ??= (async () => {
    const hash = createHash("sha256");
    for (const file of [
      ...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: frameworkDirectory }),
    ].sort())
      hash.update(file).update(await readFile(join(frameworkDirectory, file)));
    const lock = governingLock(frameworkDirectory);
    if (lock) hash.update(await readFile(lock));
    return hash.digest("hex");
  })();
  return frameworkHash;
}

async function run(
  command: readonly string[],
  { cwd, quiet = true }: { cwd?: string; quiet?: boolean } = {},
) {
  const child = Bun.spawn([...command], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    // git's own progress and warnings ("filtering not recognized") only matter on failure.
    stderr: quiet ? "pipe" : "inherit",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    quiet ? new Response(child.stderr).text() : Promise.resolve(""),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(
      `${command.slice(0, 2).join(" ")} failed (${code}): ${stderr.trim() || stdout.trim()}`,
    );
  return stdout;
}

/**
 * The commit `ref` names on the remote: an exact branch first, then a tag (peeled when
 * annotated), then a full ref name. `fixed` is true for tags.
 */
async function lsRemote(git: string, url: string, ref: string | undefined) {
  const output = await run([git, "ls-remote", "--", url, ...(ref ? [] : ["HEAD"])]);
  const refs = new Map(
    output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha = "", name = ""] = line.split("\t");
        return [name, sha] as const;
      }),
  );
  if (!ref) {
    const head = refs.get("HEAD");
    if (!head) throw new Error(`${url} has no HEAD`);
    return { sha: head, fixed: false };
  }
  const branch = refs.get(`refs/heads/${ref}`);
  if (branch) return { sha: branch, fixed: false };
  const tag = refs.get(`refs/tags/${ref}^{}`) ?? refs.get(`refs/tags/${ref}`);
  if (tag) return { sha: tag, fixed: true };
  const exact = refs.get(ref);
  if (exact) return { sha: exact, fixed: ref.startsWith("refs/tags/") };
  throw new Error(`${url} has no branch or tag "${ref}"`);
}

/**
 * The directory a repository is checked out as: its name, so that an app at its root is
 * named after it (the build names the Client and its title after the directory).
 */
export function repositoryName(url: string) {
  const name = (url.replace(/\/+$/, "").split(/[/:]/).at(-1) ?? "").replace(/\.git$/, "");
  return APP_NAME.test(name) ? name : "app";
}

/**
 * Shallow, blobless fetch of one commit into `<root>/<sha>/<repository name>`, published
 * whole by a rename.
 */
async function checkout(git: string, url: string, sha: string, root: string) {
  const target = join(root, sha);
  const repository = join(target, repositoryName(url));
  if (existsSync(target)) return repository;
  await mkdir(root, { recursive: true });
  const staging = await mkdtemp(join(root, ".fetch-"));
  const cwd = join(staging, repositoryName(url));
  try {
    await mkdir(cwd);
    await run([git, "init", "-q"], { cwd });
    await run([git, "remote", "add", "origin", url], { cwd });
    await run([git, "fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", sha], { cwd });
    await run([git, "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", sha], {
      cwd,
    });
    await rename(staging, target).catch((error: unknown) => {
      if (!existsSync(target)) throw error;
    });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return repository;
}

async function commitSummary(git: string, checkoutDirectory: string) {
  return (
    await run([git, "log", "-1", "--format=%h %s%n  %an, %ad", "--date=short"], {
      cwd: checkoutDirectory,
    })
  ).trim();
}

// A new commit of an accepted repository is announced with at most this many commits.
const NEW_COMMITS_SHOWN = 10;

/**
 * The commits after `previous` up to `sha`, newest first, at most NEW_COMMITS_SHOWN:
 * the checkout is deepened just enough. `more` when `previous` was not reached (more
 * commits, or a rewritten history); offline, only the new commit itself is known.
 */
async function newCommits(git: string, repository: string, previous: string, sha: string) {
  await run([git, "fetch", "-q", "--depth", String(NEW_COMMITS_SHOWN + 1), "origin", sha], {
    cwd: repository,
  }).catch(() => undefined);
  const lines = (
    await run([git, "log", `-${NEW_COMMITS_SHOWN + 1}`, "--format=%H %h %s", sha], {
      cwd: repository,
    })
  )
    .trim()
    .split("\n");
  const reached = lines.findIndex((line) => line.startsWith(previous));
  const listed = (reached < 0 ? lines : lines.slice(0, reached)).slice(0, NEW_COMMITS_SHOWN);
  return {
    commits: listed.map((line) => line.slice(line.indexOf(" ") + 1)),
    more: reached < 0,
  };
}

/**
 * A repository is accepted once, by URL: its first launch shows the commit and asks;
 * refusing stops the launch before anything of it ran. A new commit of an accepted
 * repository runs without asking, after a short account of what changed.
 */
async function ensureTrusted(
  source: GitSource,
  sha: string,
  repository: string,
  { directories, confirm, log, git = "git" }: GitOptions,
) {
  const file = join(directories.config, "trust.json");
  const trust = await readJson(file, Trust, {});
  const previous = trust[source.url];
  if (previous?.sha === sha) return;
  if (previous) {
    const { commits, more } = await newCommits(git, repository, previous.sha, sha);
    log(
      `${source.url} changed since ${short(previous.sha)}:\n` +
        commits.map((commit) => `  ${commit}`).join("\n") +
        (more ? "\n  … (earlier commits not shown)" : ""),
    );
  } else {
    const summary = await commitSummary(git, repository);
    const question =
      `${source.url} was never run here.\nCommit ${sha}\n  ${summary}\n` +
      "It runs as you, its Server included. Run it?";
    if (!(await confirm(question)))
      throw new Error(`${source.url} at ${short(sha)} was not accepted: nothing was run`);
  }
  await writeJson(file, { ...trust, [source.url]: { sha, at: new Date().toISOString() } });
}

/**
 * The directory whose bun.lock the app installs from: its own, else an enclosing one in
 * the repository (a workspace). None when the app declares no packages.
 */
function lockDirectory(app: string, repository: string) {
  for (let directory = app; ; directory = dirname(directory)) {
    if (existsSync(join(directory, "bun.lock"))) return directory;
    if (directory === repository || directory === dirname(directory)) break;
  }
  // A package.json without bun.lock would install whatever resolves today.
  if (existsSync(join(app, "package.json")))
    throw new Error(`${app}/package.json has no bun.lock: it cannot be installed reproducibly`);
  return undefined;
}

async function installAndBuild(app: string, repository: string, options: GitOptions) {
  const { bun = process.execPath, log } = options;
  const found = lockDirectory(app, repository);
  const lock = found ? sha256(await readFile(join(found, "bun.lock"))) : "none";
  const marker = join(app, ".airtty-launch.json");
  const built = await readJson(marker, z.optional(Built), undefined);
  const current = { lock, framework: await framework() };
  if (built?.lock === current.lock && built.framework === current.framework) return;
  // Bun runs no dependency's lifecycle scripts unless the app lists it in
  // trustedDependencies: that default is kept, never widened here.
  if (found) {
    log(`Installing dependencies (bun install --frozen-lockfile)…`);
    await run([bun, "install", "--frozen-lockfile"], { cwd: found });
  }
  log("Building…");
  await (options.build ?? build)(app);
  await writeJson(marker, current);
}

/**
 * Resolves, fetches, trusts, installs and builds `source`; returns the app's directory,
 * built, ready to launch.
 */
export async function prepareGitApp(source: GitSource, options: GitOptions) {
  const { directories, log, git = "git" } = options;
  const root = join(directories.git, sha256(source.url).slice(0, URL_KEY));
  const refsFile = join(root, "refs.json");
  const refName = source.ref ?? "HEAD";
  const known = (await readJson(refsFile, Refs, {}))[refName];
  let resolved: { sha: string; fixed: boolean };
  if (source.ref && FULL_SHA.test(source.ref)) resolved = { sha: source.ref, fixed: true };
  else if (known?.fixed) resolved = known;
  else
    try {
      resolved = await lsRemote(git, source.url, source.ref);
    } catch (error: unknown) {
      if (!known || !existsSync(join(root, known.sha))) throw error;
      log(
        `Warning: ${source.url} is unreachable (${messageOf(error).split("\n")[0]}); ` +
          `launching the cached ${short(known.sha)}, which may be out of date.`,
      );
      resolved = known;
    }
  await mkdir(root, { recursive: true });
  return withLock(
    join(root, `${resolved.sha}.lock`),
    async () => {
      const repository = await checkout(git, source.url, resolved.sha, root);
      await ensureTrusted(source, resolved.sha, repository, options);
      const app = join(repository, source.directory ?? "");
      if (relative(repository, app).startsWith(".."))
        throw new Error(`${source.directory}: outside the repository`);
      if (!existsSync(join(app, "app")))
        throw new Error(`${describeSource(source)}: no airtty app (app/ directory) at ${app}`);
      await installAndBuild(app, repository, options);
      await writeJson(refsFile, {
        ...(await readJson(refsFile, Refs, {})),
        [refName]: resolved,
      });
      return { directory: app, sha: resolved.sha };
    },
    { waiting: () => log(`Waiting for another launch preparing ${short(resolved.sha)}…`) },
  );
}
