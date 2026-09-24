import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../src/build";
import { messageOf } from "../src/guards";
import { prepareGitApp, repositoryName, type GitOptions } from "../src/launcher/git";
import { parseGitSource } from "../src/launcher/git-source";
import { rejectionOf } from "./helpers";

let work: string, remote: string;
const GIT_ENV = {
  GIT_AUTHOR_NAME: "Ada",
  GIT_AUTHOR_EMAIL: "ada@example.com",
  GIT_COMMITTER_NAME: "Ada",
  GIT_COMMITTER_EMAIL: "ada@example.com",
};
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, ...GIT_ENV } });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
const commit = (message: string) => {
  git(remote, "add", "-A");
  git(remote, "commit", "-qm", message);
  return git(remote, "rev-parse", "HEAD");
};

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "airtty-git-"));
  remote = join(work, "remote");
  // A repository holding Notes in a subdirectory, as a monorepo would.
  for (const part of ["app", "components", "actions", "server", "tsconfig.json"])
    await cp(resolve("examples/notes", part), join(remote, "apps/notes", part), {
      recursive: true,
      filter: (p) => !p.includes(".airtty"),
    });
  git(remote, "init", "-q", "-b", "main");
  commit("Notes");
});
afterAll(() => rm(work, { recursive: true, force: true }));

test("a repository is checked out under its own name", () => {
  expect(repositoryName("https://github.com/ada/notes.git")).toBe("notes");
  expect(repositoryName("git@example.com:ada/tools.git")).toBe("tools");
  expect(repositoryName("file:///srv/tools/")).toBe("tools");
  expect(repositoryName("file:///srv/-x")).toBe("app");
});

test("git sources: hosts, URLs, refs and subdirectories", () => {
  expect(parseGitSource("github:ada/notes")).toEqual({
    url: "https://github.com/ada/notes.git",
    ref: undefined,
    directory: undefined,
  });
  expect(parseGitSource("github:ada/tools/apps/notes")).toEqual({
    url: "https://github.com/ada/tools.git",
    ref: undefined,
    directory: "apps/notes",
  });
  expect(parseGitSource("github:ada/tools#v1.2/apps/notes")).toEqual({
    url: "https://github.com/ada/tools.git",
    ref: "v1.2",
    directory: "apps/notes",
  });
  expect(parseGitSource("https://github.com/ada/tools/tree/main/apps/notes")).toEqual({
    url: "https://github.com/ada/tools.git",
    ref: "main",
    directory: "apps/notes",
  });
  expect(parseGitSource("https://gitlab.com/ada/tools.git#dev")).toEqual({
    url: "https://gitlab.com/ada/tools.git",
    ref: "dev",
    directory: undefined,
  });
  expect(parseGitSource("git+ssh://git@example.com/ada/tools.git/apps/notes#main")).toEqual({
    url: "ssh://git@example.com/ada/tools.git",
    ref: "main",
    directory: "apps/notes",
  });
  expect(parseGitSource("git+file:///srv/tools#main/apps/notes")).toEqual({
    url: "file:///srv/tools",
    ref: "main",
    directory: "apps/notes",
  });
  // Not git: npm specs, paths, Server URLs.
  for (const spec of ["@ada/notes@1.2", "notes", "./notes", "https://notes.example.com", "ssh://h"])
    expect(parseGitSource(spec)).toBeUndefined();
});

type Harness = {
  options: GitOptions;
  questions: string[];
  logs: string[];
  builds: string[];
  answer: boolean;
};
function harness(): Harness {
  const h: Harness = {
    questions: [],
    logs: [],
    builds: [],
    answer: true,
    options: {
      directories: { git: join(work, "cache/git"), config: join(work, "config") },
      confirm: async (question) => {
        h.questions.push(question);
        return h.answer;
      },
      log: (message) => h.logs.push(message),
      build: async (directory) => {
        h.builds.push(directory);
        await build(directory);
      },
    },
  };
  return h;
}

test("a repository is accepted once; a new commit is fetched, announced and built", async () => {
  const h = harness();
  const source = { url: `file://${remote}`, directory: "apps/notes" };
  // Refused: nothing of the repository ran, nothing is remembered.
  h.answer = false;
  expect(messageOf(await rejectionOf(prepareGitApp(source, h.options)))).toContain(
    "was not accepted: nothing was run",
  );
  expect(h.builds).toEqual([]);
  expect(h.questions[0]).toContain(`file://${remote} was never run here`);
  expect(h.questions[0]).toContain(git(remote, "rev-parse", "HEAD"));
  expect(h.questions[0]).toContain("Notes");
  h.answer = true;
  const first = await prepareGitApp(source, h.options);
  expect(first.sha).toBe(git(remote, "rev-parse", "HEAD"));
  // <cache>/<hash of the url>/<sha>/<repository>/<directory>
  expect(first.directory).toStartWith(join(work, "cache/git/"));
  expect(first.directory).toEndWith(join(first.sha, "remote/apps/notes"));
  expect(existsSync(join(first.directory, ".airtty/server/index.js"))).toBe(true);
  // Shallow: one commit only.
  expect(git(join(first.directory, "../.."), "rev-list", "--count", "HEAD")).toBe("1");
  expect(h.builds).toHaveLength(1);
  expect(h.questions).toHaveLength(2);
  // Unchanged: launched as is, no question, no build.
  expect(await prepareGitApp(source, h.options)).toEqual(first);
  expect(h.builds).toHaveLength(1);
  expect(h.questions).toHaveLength(2);
  // New commits of the accepted repository: no question, an account of them, a build.
  await Bun.write(join(remote, "apps/notes/README.md"), "Notes\n");
  commit("Add a README");
  await Bun.write(join(remote, "apps/notes/CHANGES.md"), "Changes\n");
  const second = commit("Add a changelog");
  const next = await prepareGitApp(source, h.options);
  expect(next.sha).toBe(second);
  expect(h.questions).toHaveLength(2);
  const account = h.logs.find((line) => line.includes("changed since")) ?? "";
  expect(account).toStartWith(`file://${remote} changed since ${first.sha.slice(0, 12)}:`);
  const [, newest, older] = account.split("\n");
  expect(newest).toBe(`  ${second.slice(0, 7)} Add a changelog`);
  expect(older).toMatch(/^  [0-9a-f]{7} Add a README$/);
  expect(h.builds).toHaveLength(2);
  // Many commits: the account stays short and says it is cut.
  for (let i = 1; i <= 12; i++) {
    await Bun.write(join(remote, "apps/notes/CHANGES.md"), `Change ${i}\n`);
    commit(`Change ${i}`);
  }
  h.logs.length = 0;
  await prepareGitApp(source, h.options);
  const long = (h.logs.find((line) => line.includes("changed since")) ?? "").split("\n");
  expect(long).toHaveLength(12);
  expect(long[1]).toEndWith("Change 12");
  expect(long.at(-1)).toBe("  … (earlier commits not shown)");
  expect(h.questions).toHaveLength(2);
  const trust: unknown = JSON.parse(await readFile(join(work, "config/trust.json"), "utf8"));
  expect(trust).toMatchObject({ [`file://${remote}`]: { sha: git(remote, "rev-parse", "HEAD") } });
}, 60000);

test("offline, a branch launches its last checkout with a warning; tags and shas never ask", async () => {
  const h = harness();
  git(remote, "tag", "v1");
  const tagged = { url: `file://${remote}`, ref: "v1", directory: "apps/notes" };
  const branch = { url: `file://${remote}`, ref: "main", directory: "apps/notes" };
  const v1 = await prepareGitApp(tagged, h.options);
  const main = await prepareGitApp(branch, h.options);
  const byHash = await prepareGitApp({ ...branch, ref: main.sha }, h.options);
  expect(byHash.sha).toBe(main.sha);
  // The remote disappears.
  await rename(remote, `${remote}-away`);
  try {
    h.logs.length = 0;
    expect(await prepareGitApp(tagged, h.options)).toEqual(v1);
    expect(await prepareGitApp({ ...branch, ref: main.sha }, h.options)).toEqual(byHash);
    expect(h.logs).toEqual([]);
    expect(await prepareGitApp(branch, h.options)).toEqual(main);
    expect(h.logs.join("\n")).toContain("unreachable");
    expect(h.logs.join("\n")).toContain(`launching the cached ${main.sha.slice(0, 12)}`);
    // Never launched from here: nothing to fall back on.
    expect(
      messageOf(await rejectionOf(prepareGitApp({ ...branch, ref: "other" }, h.options))),
    ).toContain("ls-remote");
  } finally {
    await rename(`${remote}-away`, remote);
  }
}, 60000);

test("an app is installed from its bun.lock only; a missing ref or app is explained", async () => {
  const h = harness();
  const app = join(remote, "apps/notes");
  // A local package: `bun install` locks it without the network.
  await Bun.write(join(app, "dep/package.json"), JSON.stringify({ name: "dep", version: "1.0.0" }));
  await Bun.write(join(app, ".gitignore"), "node_modules\n");
  await Bun.write(
    join(app, "package.json"),
    JSON.stringify({ name: "notes", private: true, dependencies: { dep: "file:./dep" } }),
  );
  commit("Declare packages without a lockfile");
  const source = { url: `file://${remote}`, directory: "apps/notes" };
  expect(messageOf(await rejectionOf(prepareGitApp(source, h.options)))).toContain(
    "has no bun.lock",
  );
  expect(Bun.spawnSync([process.execPath, "install"], { cwd: app }).exitCode).toBe(0);
  commit("Lock");
  await prepareGitApp(source, h.options);
  expect(h.logs).toContain("Installing dependencies (bun install --frozen-lockfile)…");
  expect(existsSync(join(h.builds[0] ?? "", "node_modules/dep/package.json"))).toBe(true);
  expect(
    messageOf(await rejectionOf(prepareGitApp({ ...source, ref: "nope" }, h.options))),
  ).toContain('has no branch or tag "nope"');
  expect(
    messageOf(await rejectionOf(prepareGitApp({ ...source, directory: "apps" }, h.options))),
  ).toContain("no airtty app");
  expect(
    messageOf(await rejectionOf(prepareGitApp({ ...source, directory: "../x" }, h.options))),
  ).toContain("outside the repository");
}, 60000);
