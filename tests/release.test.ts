import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  CHANGELOG,
  PACKAGES,
  READMES,
  STATUS,
  bumpChangelog,
  bumpManifest,
  bumpReadme,
  bumpStatus,
  isPrerelease,
} from "../scripts/release.ts";

// scripts/release.ts edits the repository's own files by anchors: each test runs an edit on
// the file as it is today, so a file that loses its anchor fails here before a release does.
const root = resolve(import.meta.dir, "..");
const read = (file: string) => readFileSync(join(root, file), "utf8");
const Manifest = z.looseObject({ version: z.string() });
const manifest = (text: string) => Manifest.parse(JSON.parse(text));
const current = manifest(read("packages/core/package.json")).version;
const next = "9.8.7-rc.1";

describe("a release", () => {
  test("starts from one version shared by the five packages", () => {
    for (const dir of PACKAGES)
      expect(manifest(read(`${dir}/package.json`)).version, dir).toBe(current);
  });

  test("moves each package's version, and only it", () => {
    for (const dir of PACKAGES) {
      const file = `${dir}/package.json`;
      const before = manifest(read(file));
      const after = manifest(bumpManifest(read(file), file, current, next));
      expect(after).toEqual({ ...before, version: next });
    }
  });

  test("points every shipped README link at the release's tag", () => {
    for (const file of READMES) {
      const after = bumpReadme(read(file), file, current, next);
      const refs = [...after.matchAll(/luciole\/(?:blob|tree)\/(v[^/]+)\//g)].map(([, ref]) => ref);
      expect(refs.length, file).toBeGreaterThan(0);
      expect(new Set(refs), file).toEqual(new Set([`v${next}`]));
    }
  });

  test("dates the changelog entry and keeps an empty [Unreleased] above it", () => {
    const text = read(CHANGELOG).replace("## [Unreleased]\n", "## [Unreleased]\n\n- A change.\n");
    const after = bumpChangelog(text, current, next, "2031-02-03");
    expect(after).toContain(`## [Unreleased]\n\n## [${next}] - 2031-02-03\n\n- A change.\n`);
    expect(after).toContain(
      `[Unreleased]: https://github.com/sykar-f/luciole/compare/v${next}...HEAD`,
    );
    expect(after).toContain(`[${next}]: https://github.com/sykar-f/luciole/releases/tag/v${next}`);
  });

  test("refuses a changelog that says nothing about the release", () => {
    const empty = "## [Unreleased]\n\n## [0.1.0] - 2026-10-06\n";
    expect(() => bumpChangelog(empty, current, next, "2031-02-03")).toThrow(/is empty/);
  });

  test("moves the /status/ check to the day and the revision", () => {
    expect(bumpStatus(read(STATUS), "2031-02-03", "abc1234")).toContain(
      'const CHECKED = { date: "3 February 2031", revision: "abc1234" };',
    );
  });

  test("with a suffix is a prerelease", () => {
    expect(isPrerelease("0.2.0-rc.1")).toBe(true);
    expect(isPrerelease("0.2.0")).toBe(false);
  });
});
