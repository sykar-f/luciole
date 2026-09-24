/**
 * An app launched from a git repository: `github:user/repo[#ref][/dir]`,
 * `https://github.com/user/repo[/tree/ref/dir]`, `git+ssh://…`, `git+https://…`,
 * `git+file://…` (a fragment carries `#ref[/dir]`).
 *
 * Each commit is checked out once in `<cache>/<hash of url>/<sha>` (a shallow, blobless
 * fetch), installed with `bun install --frozen-lockfile` and built; the build is reused
 * while the commit, its bun.lock and the framework stay the same. A branch is checked
 * with `git ls-remote` on every launch; a commit sha or a tag never moves, so it is not.
 * Offline, the last checkout of that ref is launched with a warning.
 *
 * A repository is arbitrary code, its Server included: its first commit and every new one
 * are shown and must be accepted before anything of it runs (install scripts, bundler
 * macros, the app). The answer is remembered in `<config>/trust.json`.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import * as z from "zod/mini";
import { build } from "../build";
import { messageOf } from "../guards";
import { withLock } from "./lock";
import type { Directories } from "./paths";
import type { Confirm } from "./prompt";

export type GitSource = {
  /** What git fetches from. */
  url: string;
  /** Branch, tag or full commit sha; the remote's HEAD when absent. */
  ref?: string;
  /** The app's directory inside the repository. */
  directory?: string;
};

const FULL_SHA = /^[0-9a-f]{40}$/;
// What a commit or a cache key reads as: enough to tell apart, short enough to read.
const SHORT_SHA = 12;
const URL_KEY = 16;
const short = (sha: string) => sha.slice(0, SHORT_SHA);
const HOSTS = { github: "github.com", gitlab: "gitlab.com" } as const;
const HOST_SHORTHAND = /^(github|gitlab):([\w.-]+)\/([\w.-]+?)(?:\.git)?(\/[^#]*)?(?:#(.*))?$/;
const HOST_URL =
  /^https:\/\/(github\.com|gitlab\.com)\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(\/[^#]*)?(?:#(.*))?$/;
const GIT_URL = /^git\+(ssh|https|http|file):\/\/|^git:\/\//;

/** `ref[/dir]`, as written after `#`. A branch containing "/" cannot be written so. */
function fragment(text: string | undefined) {
  if (!text) return {};
  const [ref, ...rest] = text.split("/");
  return { ref: ref || undefined, directory: rest.join("/") || undefined };
}
const trimSlashes = (path: string | undefined) => path?.replace(/^\/+|\/+$/g, "") || undefined;

/** The git source `spec` names, or `undefined` when it is not one. */
export function parseGitSource(spec: string): GitSource | undefined {
  const hosted = HOST_SHORTHAND.exec(spec) ?? HOST_URL.exec(spec);
  if (hosted) {
    const [, site = "", owner = "", repo = "", path, hash] = hosted;
    const host = site === "github" ? HOSTS.github : site === "gitlab" ? HOSTS.gitlab : site;
    let directory = trimSlashes(path);
    let ref: string | undefined;
    // What a browser shows: https://github.com/user/repo/tree/<ref>/<dir>.
    const tree = directory && /^(?:-\/)?tree\/([^/]+)(?:\/(.*))?$/.exec(directory);
    if (tree) [, ref, directory] = tree;
    const after = fragment(hash);
    return {
      url: `https://${host}/${owner}/${repo}.git`,
      ref: after.ref ?? ref,
      directory: trimSlashes(after.directory ?? directory),
    };
  }
  if (!GIT_URL.test(spec)) return undefined;
  const [location = "", hash] = spec.replace(/^git\+/, "").split("#", 2);
  // A directory after the repository's `.git`: git+ssh://host/repo.git/apps/notes.
  const inRepo = /^(.*?\.git)(\/.*)?$/.exec(location);
  const after = fragment(hash);
  return {
    url: inRepo?.[1] ?? location,
    ref: after.ref,
    directory: trimSlashes(after.directory ?? inRepo?.[2]),
  };
}

/** How the source reads back to the user. */
export const describeSource = ({ url, ref, directory }: GitSource) =>
  `${url}${ref ? `#${ref}` : ""}${directory ? ` (${directory})` : ""}`;

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
/** `<config>/trust.json`: the commit the user last accepted, per repository. */
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
    hash.update(await readFile(join(frameworkDirectory, "../bun.lock")).catch(() => ""));
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

/** Shallow, blobless fetch of one commit, published whole by a rename. */
async function checkout(git: string, url: string, sha: string, root: string) {
  const target = join(root, sha);
  if (existsSync(target)) return target;
  await mkdir(root, { recursive: true });
  const staging = await mkdtemp(join(root, ".fetch-"));
  try {
    await run([git, "init", "-q"], { cwd: staging });
    await run([git, "remote", "add", "origin", url], { cwd: staging });
    await run([git, "fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", sha], {
      cwd: staging,
    });
    await run([git, "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", sha], {
      cwd: staging,
    });
    await rename(staging, target).catch((error: unknown) => {
      if (!existsSync(target)) throw error;
    });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return target;
}

async function commitSummary(git: string, checkoutDirectory: string) {
  return (
    await run([git, "log", "-1", "--format=%h %s%n  %an, %ad", "--date=short"], {
      cwd: checkoutDirectory,
    })
  ).trim();
}

/**
 * Asks before the first commit of a repository runs, then before each new one. Refusing
 * stops the launch before anything of the repository ran.
 */
async function ensureTrusted(
  source: GitSource,
  sha: string,
  checkoutDirectory: string,
  { directories, confirm, git = "git" }: GitOptions,
) {
  const file = join(directories.config, "trust.json");
  const trust = await readJson(file, Trust, {});
  const previous = trust[source.url];
  if (previous?.sha === sha) return;
  const summary = await commitSummary(git, checkoutDirectory);
  const question =
    `${source.url} ${previous ? `changed since ${short(previous.sha)}` : "was never run here"}.\n` +
    `Commit ${sha}\n  ${summary}\n` +
    "It runs as you, its Server included. Run it?";
  if (!(await confirm(question)))
    throw new Error(`${source.url} at ${short(sha)} was not accepted: nothing was run`);
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
