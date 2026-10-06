import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXAMPLES_REPOSITORY,
  exampleTarget,
  listExamples,
  resolveExample,
  releaseTag,
} from "../packages/core/src/commands/example";
import { messageOf } from "../packages/core/src/guards";
import { prepareGitApp } from "../packages/core/src/launcher/git";
import { parseGitSource } from "../packages/core/src/launcher/git-source";
import { acceptAll } from "../packages/core/src/launcher/prompt";
import { readPackageJson } from "../packages/core/src/package-json";
import { BUILD_TEST_MS, execute, launch, rejectionOf } from "./helpers";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Ada",
  GIT_AUTHOR_EMAIL: "ada@example.com",
  GIT_COMMITTER_NAME: "Ada",
  GIT_COMMITTER_EMAIL: "ada@example.com",
};
async function git(cwd: string, ...args: string[]) {
  const result = await execute(["git", ...args], { cwd, env: { ...process.env, ...GIT_ENV } });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

const AVAILABLE = ["forge", "notes"];

test("an example is the git source of its name, at the release tag", () => {
  expect(releaseTag("1.2.3")).toBe("v1.2.3");
  const target = exampleTarget("notes", AVAILABLE, "1.2.3");
  expect(target).toBe("github:sykar-f/luciole#v1.2.3/examples/notes");
  expect(parseGitSource(target)).toEqual({
    url: "https://github.com/sykar-f/luciole.git",
    ref: "v1.2.3",
    directory: "examples/notes",
  });
  expect(exampleTarget("notes", AVAILABLE, "1.2.3", "git+file:///srv/luciole")).toBe(
    "git+file:///srv/luciole#v1.2.3/examples/notes",
  );
  expect(EXAMPLES_REPOSITORY).toBe("github:sykar-f/luciole");
});

test("an unknown example is refused with the ones that exist", () => {
  expect(() => exampleTarget("nope", AVAILABLE, "1.2.3")).toThrow(
    'No example named "nope" at v1.2.3. Available: forge, notes',
  );
  // A path-like name never escapes the examples directory.
  expect(() => exampleTarget("../packages", AVAILABLE, "1.2.3")).toThrow("No example named");
});

let work: string, clone: string, version: string;
beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "luciole-example-"));
  clone = join(work, "clone");
  // A local clone of this checkout's HEAD, tagged as the release workflow will tag it.
  const root = join(import.meta.dir, "..");
  ({ version = "" } = await readPackageJson(join(root, "packages/core/package.json")));
  await git(work, "clone", "--quiet", root, clone);
  // --force: the clone carries the published tags, and this one must name the clone's HEAD.
  await git(clone, "tag", "--force", releaseTag(version));
});
afterAll(() => rm(work, { recursive: true, force: true }));

test("the examples of a tag are listed from git", async () => {
  const names = await listExamples(`git+file://${clone}`, releaseTag(version));
  expect(names).toContain("notes");
  expect(names).toContain("latency");
  expect(await rejectionOf(listExamples(`git+file://${clone}`, "v0.0.0-none"))).toBeDefined();
});

test("a listing that fails explains the tag; a named launch still reaches the launcher", async () => {
  const repository = `git+file://${join(work, "absent")}`;
  const message = messageOf(await rejectionOf(listExamples(repository, releaseTag(version))));
  expect(message).toContain(`Cannot list the examples at v${version} of ${repository}`);
  expect(message).toContain("git tag of the running release");
  expect(message).toContain("LUCIOLE_EXAMPLES_REPO");
  // Unreachable repository: no verdict on the name, the launcher resolves (cache, errors).
  expect(await resolveExample("notes", repository, version)).toBe(
    `${repository}#v${version}/examples/notes`,
  );
  // A listing that succeeds still refuses an unknown name.
  const list = () => Promise.resolve(AVAILABLE);
  expect(await rejectionOf(resolveExample("nope", repository, version, list))).toBeDefined();
});

test("the CLI refuses an unknown example and lists the available ones", async () => {
  const cli = join(import.meta.dir, "../packages/core/src/cli.ts");
  const env = { ...process.env, LUCIOLE_EXAMPLES_REPO: `git+file://${clone}` };
  const unknown = await execute([process.execPath, cli, "example", "nope"], { env });
  expect(unknown.exitCode).not.toBe(0);
  expect(unknown.stderr.toString()).toContain(`No example named "nope" at v${version}`);
  expect(unknown.stderr.toString()).toMatch(/Available: .*latency/);
  const listing = await execute([process.execPath, cli, "example"], { env });
  expect(listing.exitCode).toBe(0);
  expect(listing.stdout.toString()).toContain("latency");
  const missing = await execute([process.execPath, cli, "example"], {
    env: { ...env, LUCIOLE_EXAMPLES_REPO: `git+file://${join(work, "absent")}` },
  });
  expect(missing.exitCode).not.toBe(0);
  expect(missing.stderr.toString()).toContain("git tag of the running release");
});

test(
  "an example launches from a git+file source at the release tag",
  async () => {
    const source = parseGitSource(
      exampleTarget("latency", ["latency"], version, `git+file://${clone}`),
    );
    if (!source) throw new Error("not a git source");
    const { directory } = await prepareGitApp(source, {
      directories: { git: join(work, "cache/git"), config: join(work, "config") },
      confirm: acceptAll,
      log: () => {},
    });
    const server = await launch(join(directory, ".luciole/server/index.js"));
    try {
      expect(server.port).toBeGreaterThan(0);
    } finally {
      await server.stop();
    }
  },
  BUILD_TEST_MS * 5,
);
