import { execFileSync } from "node:child_process";
import { z } from "zod";

export const repo = "https://github.com/sykar-f/luciole";

/**
 * The files whose link follows `main` rather than the build, each with its reason: what they
 * say is meant to be read as it stands today, not as it stood when the site was built.
 * Every other link to a file of the repository names the build's commit (`revision`), so
 * a page and the code it cites stay in step; scripts/check-html.ts refuses any other
 * `blob/main` or `tree/main` link in the built site.
 */
export const LIVE: Readonly<Record<string, string>> = {
  "CHANGELOG.md": "lists the releases published since the page was built",
  "SECURITY.md": "the way to report a vulnerability is the one in force today",
  LICENSE: "the licence a reader takes the code under is the current one",
  "CONTRIBUTING.md": "a contribution follows today's process",
};

/** A full commit SHA, as git and GITHUB_SHA give it. */
const Commit = z.string().regex(/^[0-9a-f]{40}$/);

/**
 * The commit a build reads its files from: the checkout's HEAD, which is the tree built
 * whatever the trigger (a `workflow_run` sets GITHUB_SHA to main's tip, not to the commit
 * checked out); GITHUB_SHA only when there is no git to ask.
 */
export function buildRevision(
  env: Record<string, string | undefined> = process.env,
  head: () => string = () =>
    execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
): string {
  let sha: string | undefined;
  try {
    sha = head().trim();
  } catch {
    sha = env.GITHUB_SHA?.trim();
  }
  const found = Commit.safeParse(sha);
  if (!found.success)
    throw new Error("Links: no commit to pin to (no git checkout and no GITHUB_SHA).");
  return found.data;
}

let pinned: string | undefined;
/** The build's commit, asked once. */
export const revision = () => (pinned ??= buildRevision());

/** The link to `path` in the repository: on `main` when it is LIVE, at the build's commit otherwise. */
export function repoLink(path: string, kind: "blob" | "tree" = "blob"): string {
  return `${repo}/${kind}/${Object.hasOwn(LIVE, path) ? "main" : revision()}/${path}`;
}

export const doc = (file: string) => repoLink(`docs/${file}`);
export const source = (path: string) => repoLink(path);
