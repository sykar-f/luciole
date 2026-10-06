import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

// Prepares a release in the working tree, the step 1 of docs/RELEASING.md: the five
// publishable packages move to one version, with every file that names that version. The
// starter needs no edit: packages/create stages it at pack time, from these versions.
// It writes files and refreshes bun.lock; it never commits, tags nor publishes.
//
//   bun scripts/release.ts <version> [--date YYYY-MM-DD]
//
// A version with a suffix (0.2.0-rc.1) is a prerelease, published under the dist-tag
// `next`; it leaves /status/ alone, which only a stable release re-checks.

export const PACKAGES = [
  "packages/core",
  "packages/flow-graph",
  "packages/markdown-editor",
  "packages/create",
  "packages/luciole.sh",
] as const;
/** READMEs shipped in a tarball: their links to the repository name the release's tag. */
export const READMES = [
  "packages/flow-graph/README.md",
  "packages/markdown-editor/README.md",
] as const;
export const CHANGELOG = "CHANGELOG.md";
export const STATUS = "website/src/pages/status.astro";

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const REPO = "https://github.com/sykar-f/luciole";

export const isPrerelease = (version: string) => version.includes("-");

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replaces each pattern once at least, or throws: a file that lost its anchor is a bug here. */
function replaceAll(text: string, file: string, pattern: RegExp, by: string) {
  if (!pattern.test(text)) throw new Error(`${file}: nothing matches ${pattern}`);
  return text.replace(pattern, by);
}

export function bumpManifest(text: string, file: string, from: string, to: string) {
  return replaceAll(text, file, new RegExp(`("version": ")${escape(from)}(")`), `$1${to}$2`);
}

export function bumpReadme(text: string, file: string, from: string, to: string) {
  return replaceAll(
    text,
    file,
    new RegExp(`(luciole/(?:blob|tree)/)v${escape(from)}/`, "g"),
    `$1v${to}/`,
  );
}

/** Opens the release's entry under [Unreleased], which stays, empty, above it. */
export function bumpChangelog(text: string, from: string, to: string, date: string) {
  const unreleased = /## \[Unreleased\]\n([\s\S]*?)(?=\n## \[)/.exec(text);
  if (!unreleased) throw new Error(`${CHANGELOG}: no "## [Unreleased]" section`);
  if (unreleased[1]?.trim() === "")
    throw new Error(`${CHANGELOG}: [Unreleased] is empty; write what this release changes first`);
  let out = text.replace("## [Unreleased]\n", `## [Unreleased]\n\n## [${to}] - ${date}\n`);
  out = replaceAll(
    out,
    CHANGELOG,
    new RegExp(`^\\[Unreleased\\]: ${escape(REPO)}/compare/v${escape(from)}\\.\\.\\.HEAD$`, "m"),
    `[Unreleased]: ${REPO}/compare/v${to}...HEAD\n[${to}]: ${REPO}/releases/tag/v${to}`,
  );
  return out;
}

/** Moves the "checked on" line of /status/ to this day and to the commit the release starts from. */
export function bumpStatus(text: string, date: string, revision: string) {
  const day = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  return replaceAll(
    text,
    STATUS,
    /const CHECKED = \{ date: "[^"]*", revision: "[^"]*" \};/,
    `const CHECKED = { date: "${day}", revision: "${revision}" };`,
  );
}

function git(root: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: root });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

async function main(argv: string[]) {
  const root = resolve(import.meta.dir, "..");
  const [to = "", ...rest] = argv;
  const dateFlag = rest.indexOf("--date");
  const date =
    dateFlag === -1 ? (new Date().toISOString().split("T")[0] ?? "") : (rest[dateFlag + 1] ?? "");
  if (!VERSION.test(to))
    throw new Error(`usage: bun scripts/release.ts <x.y.z[-pre.n]> [--date YYYY-MM-DD]`);
  if (!DATE.test(date)) throw new Error(`--date takes YYYY-MM-DD, not "${date}"`);

  const read = (file: string) => readFileSync(join(root, file), "utf8");
  const from = z
    .object({ version: z.string() })
    .parse(JSON.parse(read("packages/core/package.json"))).version;
  if (from === to) throw new Error(`the packages are already at ${to}`);
  if (git(root, "status", "--porcelain") !== "")
    throw new Error("the working tree has changes: commit or stash them first");
  if (git(root, "tag", "--list", `v${to}`) !== "") throw new Error(`the tag v${to} already exists`);

  const edits = new Map<string, string>();
  for (const dir of PACKAGES) {
    const file = `${dir}/package.json`;
    edits.set(file, bumpManifest(read(file), file, from, to));
  }
  for (const file of READMES) edits.set(file, bumpReadme(read(file), file, from, to));
  edits.set(CHANGELOG, bumpChangelog(read(CHANGELOG), from, to, date));
  if (!isPrerelease(to))
    edits.set(STATUS, bumpStatus(read(STATUS), date, git(root, "rev-parse", "--short=7", "HEAD")));

  // Every edit is computed before the first write: a missing anchor leaves the tree untouched.
  for (const [file, text] of edits) writeFileSync(join(root, file), text);
  const install = Bun.spawnSync(["bun", "install"], {
    cwd: root,
    stdout: "ignore",
    stderr: "inherit",
  });
  if (install.exitCode !== 0) throw new Error("bun install failed: bun.lock is not refreshed");

  const channel = isPrerelease(to) ? "next" : "latest";
  console.log(`${from} -> ${to} (npm dist-tag ${channel}), dated ${date}.
Changed: ${[...edits.keys(), "bun.lock"].join(", ")}.

Next (docs/RELEASING.md):
${isPrerelease(to) ? "" : "  - re-read /status/ line by line against the code and the CI;\n  - update the version wherever the docs cite it (README, SECURITY.md, site);\n"}  - commit, merge to main, push, wait for a green CI;
  - the owner tags it: git tag v${to} && git push origin v${to};
  - the owner approves the \`npm\` environment in Actions -> Release;
  - smoke test: bunx luciole.sh@${to} init my-app`);
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`release: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
