import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { QUERIES, chromeOf, openIndex, searchProblems } from "../website/scripts/check-search.ts";

// The check on the site's search (website/scripts/check-search.ts, run by the website's
// `bun run build` after Pagefind): on the built dist/, then on small sites indexed here by
// the same Pagefind binary, one page out of place per case.
const root = resolve(import.meta.dir, "..");
const website = join(root, "website");
const dist = join(website, "dist");
const directories: string[] = [];
afterAll(() => directories.forEach((directory) => rmSync(directory, { recursive: true })));

/** What the layouts put around a page's body. */
const SKIP = '<a class="skip" href="#main">Skip to content</a>';
const HEADER =
  '<header class="header"><a class="mark" href="/">lucıole.sh</a><a class="repo" href="#">GitHub ★</a></header>';
const FOOTER = '<footer class="footer"><p class="name">luciole means firefly.</p></footer>';
const CHROME = ["Skip to content", "lucıole.sh", "GitHub ★", "luciole means firefly."];

/** A built page: its chrome, then `main`, marked as the body unless `body` is false. */
const page = (main: string, { body = true } = {}) =>
  `<!doctype html><html lang="en"><head><title>t</title></head><body>${SKIP}${HEADER}` +
  `<main${body ? " data-pagefind-body" : ""}>${main}</main>${FOOTER}</body></html>`;

/** A site of `pages` by path, indexed the way the build does. */
async function indexed(pages: Record<string, string>) {
  const site = mkdtempSync(join(tmpdir(), "docs-search-"));
  directories.push(site);
  for (const [path, html] of Object.entries(pages)) {
    mkdirSync(join(site, path), { recursive: true });
    writeFileSync(join(site, path, "index.html"), html);
  }
  const run = Bun.spawnSync([join(website, "node_modules/.bin/pagefind"), "--site", site]);
  expect(run.exitCode).toBe(0);
  return openIndex(site);
}

test("the built site finds each query's page first and indexes no chrome", async () => {
  if (!existsSync(join(dist, "pagefind", "pagefind.js")))
    throw new Error("no website/dist/pagefind: run `bun run build` in website/ first");
  const chrome = await chromeOf(readFileSync(join(dist, "docs", "index.html"), "utf8"));
  for (const text of ["Skip to content", "lucıole.sh", "Docs menu"]) expect(chrome).toContain(text);
  expect(await searchProblems(await openIndex(dist), QUERIES, chrome)).toEqual([]);
});

test("the queries name each kind of page once, in one list", () => {
  expect(QUERIES).toHaveLength(10);
  expect(new Set(QUERIES.map(({ query }) => query)).size).toBe(QUERIES.length);
  for (const url of ["/status/", "/examples/", "/docs/", "/docs/reference/troubleshooting/"])
    expect(QUERIES.map((query) => query.url)).toContain(url);
});

test("the chrome is read from the skip link, the header, the footer and the sidebar", async () => {
  const sidebar =
    '<nav class="sidebar"><details><summary>Docs menu</summary><label for="q">Search the docs</label></details></nav>';
  expect(await chromeOf(page(sidebar))).toEqual([
    "Skip to content",
    "lucıole.sh",
    "GitHub ★",
    "Docs menu",
    "Search the docs",
    "luciole means firefly.",
  ]);
});

test("a query whose page is found second or not at all fails", async () => {
  const index = await indexed({
    a: page("<h1>Lanterns</h1><p>A lantern, a lantern, a lantern lights the glow.</p>"),
    b: page("<h1>Glow</h1><p>A glow.</p>"),
    c: page("<h1>Moths</h1><p>Moths fly to the glow.</p>", { body: false }),
  });
  const queries = [
    { query: "lantern", url: "/a/" },
    { query: "lantern", url: "/b/" },
    { query: "moths", url: "/c/" },
  ];
  expect(await searchProblems(index, queries, CHROME)).toEqual([
    '"lantern" finds /a/ first, not /b/',
    '"moths" finds nothing first, not /c/',
  ]);
});

test("chrome inside the indexed body fails, once per page and text", async () => {
  // No body marked: Pagefind indexes <body>, minus its <nav> and <footer>.
  const index = await indexed({
    a: page("<p>Lanterns.</p>", { body: false }),
    b: page("<p>Moths.</p>", { body: false }),
  });
  // The footer's paragraph is not among them: Pagefind skips the <footer> on its own.
  const problems = await searchProblems(index, [], CHROME);
  expect(problems.toSorted()).toEqual(
    ["a", "b"].flatMap((path) =>
      ["GitHub ★", "Skip to content", "lucıole.sh"].map(
        (text) => `/${path}/ indexes the chrome "${text}"`,
      ),
    ),
  );
});

test("a page with no chrome to read fails: nothing would be checked", async () => {
  const index = await indexed({ a: page("<p>Lanterns.</p>") });
  expect(await searchProblems(index, [], [])).toEqual([
    "no chrome read from /docs/: nothing checked",
  ]);
});
