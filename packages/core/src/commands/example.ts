import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messageOf } from "../guards";
import { launch as launchTarget } from "../launcher";
import { readPackageJson } from "../package-json";
import { frameworkRoot, type Command } from "./command";
import { takeYes } from "./launch";

/** Where the examples live; `LUCIOLE_EXAMPLES_REPO` (a git URL) points elsewhere, for a fork or a test. */
export const EXAMPLES_REPOSITORY = "github:sykar-f/luciole";
/** Where an example sits in that repository. */
export const EXAMPLES_DIRECTORY = "examples";

/**
 * The git tag of a release: `v<version>`. The contract the release workflow tags with, so
 * that `luciole example` finds the examples of the release it belongs to.
 */
export const releaseTag = (version: string) => `v${version}`;

/**
 * The git source of an example, at the tag of `version`. `available` are the examples
 * that tag holds; any other name is refused with the list.
 */
export function exampleTarget(
  name: string,
  available: readonly string[],
  version: string,
  repository = EXAMPLES_REPOSITORY,
) {
  if (!available.includes(name))
    throw new Error(
      `No example named "${name}" at ${releaseTag(version)}. Available: ${available.join(", ") || "none"}`,
    );
  return `${repository}#${releaseTag(version)}/${EXAMPLES_DIRECTORY}/${name}`;
}

/** The repository as a git URL, which `git clone` takes (a `github:` shorthand expanded). */
const cloneUrl = (repository: string) =>
  repository.startsWith("github:")
    ? `https://github.com/${repository.slice("github:".length)}.git`
    : repository.replace(/^git\+/, "");

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args[0]} failed: ${err.trim() || out.trim()}`);
  return out;
}

/** The examples a tag holds: a tree-only clone of it, no file contents fetched. */
export async function listExamples(repository: string, tag: string) {
  const work = await mkdtemp(join(tmpdir(), "luciole-examples-"));
  try {
    return await listTree(work, repository, tag);
  } catch (error: unknown) {
    throw new Error(
      `Cannot list the examples at ${tag} of ${repository}: ${messageOf(error)}\n` +
        "The examples come from the git tag of the running release; a development or " +
        "unreleased version has none. LUCIOLE_EXAMPLES_REPO points to another repository.",
      { cause: error },
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function listTree(work: string, repository: string, tag: string) {
  await git(
    work,
    "clone",
    "--quiet",
    "--depth",
    "1",
    "--filter=blob:none",
    "--no-checkout",
    "--branch",
    tag,
    cloneUrl(repository),
    ".",
  );
  const tree = await git(work, "ls-tree", "-d", "--name-only", "HEAD", `${EXAMPLES_DIRECTORY}/`);
  return tree
    .split("\n")
    .filter(Boolean)
    .map((path) => path.slice(EXAMPLES_DIRECTORY.length + 1));
}

/**
 * The git source to launch for `name`. The listing gates only what it can settle: an
 * unknown name when it succeeded. When it fails (offline, say) the launcher decides: it
 * may hold the app cached, and has its own errors for the rest.
 */
export async function resolveExample(
  name: string,
  repository: string,
  version: string,
  list: typeof listExamples = listExamples,
) {
  let available: readonly string[];
  try {
    available = await list(repository, releaseTag(version));
  } catch {
    return `${repository}#${releaseTag(version)}/${EXAMPLES_DIRECTORY}/${name}`;
  }
  return exampleTarget(name, available, version, repository);
}

/**
 * `luciole example [<name>] [--yes] [app arguments]`: an example app, run from this
 * release's git tag (the launcher asks before running a repository, `--yes` accepts).
 * Without a name, lists the examples of that tag.
 */
export const example: Command = {
  usage: "example [<name> [--yes] [app arguments]]",
  flags: { "--yes": "switch" },
  forwards: true,
  async run({ args }) {
    const [, name, ...rest] = args;
    const { version } = await readPackageJson(join(frameworkRoot, "package.json"));
    if (!version) throw new Error("The framework's package.json has no version");
    const repository = process.env.LUCIOLE_EXAMPLES_REPO ?? EXAMPLES_REPOSITORY;
    if (!name) {
      const available = await listExamples(repository, releaseTag(version));
      console.log(
        `Examples at ${releaseTag(version)}:\n${available.map((n) => `  ${n}`).join("\n")}`,
      );
      return;
    }
    const target = await resolveExample(name, repository, version);
    const { args: appArgs, confirm } = takeYes(rest);
    process.exitCode = await launchTarget(target, { args: appArgs, ...confirm });
  },
};
