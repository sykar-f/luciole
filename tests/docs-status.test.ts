import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  readRepository,
  statusProblems,
  versionsOf,
  type RepositoryFiles,
} from "../website/scripts/check-status.ts";

// The check that /status/ shows the versions the repository has (website/scripts/check-status.ts,
// run by the website's `bun run build` on dist/status/). Here it reads the page's markup from
// its source, and copies of the page and of the repository's files with one version changed.
const root = resolve(import.meta.dir, "..");
const files = readRepository(root);

/** The page's markup, after its frontmatter, inside the `main` the layout gives it. */
const source = readFileSync(join(root, "website/src/pages/status.astro"), "utf8");
const page = `<main>${source.slice(source.indexOf("---", 3) + 3)}</main>`;

const problems = async (html = page, repository: RepositoryFiles = files) =>
  (await statusProblems(html, versionsOf(repository))).problems;

/** `text` with its first `from` replaced, which must be there. */
function changed(text: string, from: string, to: string) {
  expect(text).toContain(from);
  return text.replace(from, to);
}

/** That `lines` are one line per pattern, in order, each matching its pattern. */
function expectLines(lines: readonly string[], patterns: readonly RegExp[]) {
  expect(lines).toHaveLength(patterns.length);
  patterns.forEach((pattern, index) => expect(lines[index]).toMatch(pattern));
}

test("every version /status/ shows is the repository's", async () => {
  const { problems, checked } = await statusProblems(page, versionsOf(files));
  expect(problems).toEqual([]);
  expect(checked).toBeGreaterThanOrEqual(10);
});

test("a version changed on the page fails", async () => {
  expectLines(await problems(changed(page, ">0.5.12</span", ">0.5.13</span")), [
    /shows 0\.5\.13 for catalog:@opentui\/core, but package\.json/,
    /for catalog:@opentui\/react/,
    /for catalog:@opentui\/keymap/,
    /for abi:@opentui\/core, but packages\/core\/src\/abi\.ts/,
    /for abi:@opentui\/react/,
    /for abi:@opentui\/keymap/,
  ]);
});

test("a version changed in a manifest, the ABI or .bun-version fails", async () => {
  expect(
    await problems(page, { ...files, core: changed(files.core, `"^0.33.0"`, `"^0.34.0"`) }),
  ).toEqual([
    "shows ^0.33.0 for core:react-reconciler, but packages/core/package.json, " +
      "dependencies.react-reconciler is ^0.34.0",
  ]);
  expect(
    await problems(page, { ...files, core: changed(files.core, `">=1.4.2"`, `">=1.5.0"`) }),
  ).toHaveLength(2);
  const catalog = changed(
    files.workspace,
    `"@tanstack/react-router": "1.170.38"`,
    `"@tanstack/react-router": "1.171.0"`,
  );
  expectLines(await problems(page, { ...files, workspace: catalog }), [
    /for catalog:@tanstack\/react-router, .* is 1\.171\.0$/,
  ]);
  const abi = changed(files.abi, `react: "19.3.0"`, `react: "19.4.0"`);
  expectLines(await problems(page, { ...files, abi }), [
    /for abi:react, but packages\/core\/src\/abi\.ts, ABI_PACKAGES\.react is 19\.4\.0$/,
  ]);
  expect(await problems(page, { ...files, bunVersion: "1.4.3\n" })).toHaveLength(2);
});

test("a version with no mark, a mark of nothing and a page with no mark fail", async () => {
  expectLines(await problems("<main><p>React 19.3.0</p></main>"), [
    /shows 19\.3\.0 with no data-version-of/,
    /no version marked/,
  ]);
  expect(
    await problems(`<main><span data-version-of="catalog:reakt">19.3.0</span></main>`),
  ).toEqual(["19.3.0: catalog:reakt is no version of the repository"]);
  expect(await problems(`<main><span data-version-of="">19.3.0</span></main>`)).toEqual([
    "19.3.0: data-version-of names no source",
  ]);
});

test("only the main's text counts, not its scripts nor the page around it", async () => {
  const html = `<p>9.9.9</p><main><script>"9.9.9"</script>
    <span data-version-of="bun-version"> 1.4.2 </span></main><footer>9.9.9</footer>`;
  expect(await problems(html)).toEqual([]);
});

test("an engines field the check cannot read stops it", () => {
  const core = changed(files.core, `">=1.4.2"`, `"^1.4.2"`);
  expect(() => versionsOf({ ...files, core })).toThrow(/engines\.bun is "\^1\.4\.2"/);
});
