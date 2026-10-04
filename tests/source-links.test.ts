import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { LIVE, buildRevision, repo, repoLink, revision } from "../website/src/lib/links.ts";
import { sourceLink } from "../website/src/lib/docs/sources.ts";

// The links from the site to the repository's files (website/src/lib/links.ts): at the commit
// the site is built from, but for the files listed as LIVE, which follow main. The check on the
// built site that refuses any other `main` link is in check-html.test.ts.
const root = resolve(import.meta.dir, "..");
const sha = "1a5ce4bd07816007b66c4b7b51d3ab0b47540df7";
const other = "02fb6a2000000000000000000000000000000000";

describe("the build's commit", () => {
  test("is the checkout's HEAD, even when GITHUB_SHA names another commit", () => {
    expect(buildRevision({ GITHUB_SHA: other }, () => `${sha}\n`)).toBe(sha);
  });

  test("is GITHUB_SHA when there is no git to ask", () => {
    const noGit = () => {
      throw new Error("not a git repository");
    };
    expect(buildRevision({ GITHUB_SHA: other }, noGit)).toBe(other);
    expect(() => buildRevision({}, noGit)).toThrow(/no commit to pin to/);
  });

  test("is a full SHA, or the build stops", () => {
    expect(() => buildRevision({}, () => "main")).toThrow(/no commit to pin to/);
  });

  test("is this checkout's HEAD here", () => {
    const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd: root,
    }).stdout.toString();
    expect(revision()).toBe(head.trim());
  });
});

describe("a link to a file of the repository", () => {
  test("names the build's commit", () => {
    expect(repoLink("packages/core/src/cli.ts")).toBe(
      `${repo}/blob/${revision()}/packages/core/src/cli.ts`,
    );
    expect(sourceLink("examples/notes")).toBe(`${repo}/tree/${revision()}/examples/notes`);
  });

  test("follows main for a LIVE file, each listed with its reason", () => {
    for (const [path, reason] of Object.entries(LIVE)) {
      expect(repoLink(path)).toBe(`${repo}/blob/main/${path}`);
      expect(reason.length).toBeGreaterThan(10);
    }
  });
});
