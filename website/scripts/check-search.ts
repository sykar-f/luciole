/**
 * The check that the docs search finds what a reader asks for, run on dist/ after
 * `pagefind --site dist`: a query whose first result is not the page it names, or a page
 * whose index holds the site's chrome, fails the build.
 *   bun scripts/check-search.ts [dist]
 *
 * It searches with the runtime Pagefind writes to dist/pagefind/pagefind.js, the one the
 * search field loads, so it sees the ranking a reader sees. Pagefind indexes only the
 * elements marked `data-pagefind-body`, and a page without one not at all. The chrome is
 * the text the layouts put around that body, read from the built /docs/ page: the skip link,
 * the wordmark and the GitHub link of the header, which Pagefind indexes when no body is
 * marked, and the footer's paragraphs and the sidebar's labels, which it skips today only
 * because they sit in a <footer> and a <nav>.
 */
/// <reference types="bun" />

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

/** A query and the page that must come first for it. */
export interface Expected {
  query: string;
  url: string;
}

const TROUBLESHOOTING = "/docs/reference/troubleshooting/";

/** What readers search for, and where they must land. */
export const QUERIES: readonly Expected[] = [
  { query: "upgrade", url: "/docs/reference/releases/" },
  { query: "security", url: "/docs/reference/releases/" },
  { query: "bearer", url: "/docs/concepts/authentication/" },
  // Messages as the program prints them, pasted from a terminal.
  { query: "Target already contains a project", url: TROUBLESHOOTING },
  {
    query: "Remote binding requires LUCIOLE_TOKEN or server/auth.ts and a TLS reverse proxy",
    url: TROUBLESHOOTING,
  },
  { query: "Disconnected", url: TROUBLESHOOTING },
  { query: "Tested versions and accepted ranges", url: "/status/" },
  { query: "coding-agent interface", url: "/examples/" },
  { query: "Documentation", url: "/docs/" },
  { query: "use cache", url: "/docs/concepts/cache/" },
];

/** A page as the index holds it: its URL and the text it indexed. */
export interface IndexedPage {
  url: string;
  content: string;
}

/** The pages of a Pagefind index. */
export interface Index {
  /** The page `query` finds first, if any. */
  first(query: string): Promise<IndexedPage | undefined>;
  /** Every page the index holds. */
  pages(): Promise<IndexedPage[]>;
}

const Callable = z.custom<(...args: unknown[]) => unknown>((value) => typeof value === "function");
const Runtime = z.object({ options: Callable, search: Callable });
const Found = z.object({ results: z.array(z.object({ data: Callable })) });
const Page = z.object({ url: z.string(), content: z.string() });

/** The index Pagefind wrote to `<dist>/pagefind/`, searched with its own runtime. */
export async function openIndex(dist: string): Promise<Index> {
  const directory = join(resolve(dist), "pagefind");
  const runtime = Runtime.parse(await import(pathToFileURL(join(directory, "pagefind.js")).href));
  // The runtime fetches its files next to basePath and prefixes each page's URL with baseUrl.
  await runtime.options({ basePath: `${pathToFileURL(directory).href}/`, baseUrl: "/" });
  // `null` asks for every page: Pagefind's search without a term.
  const search = async (query: string | null) => Found.parse(await runtime.search(query)).results;
  const page = async (result: { data: () => unknown }) => Page.parse(await result.data());
  return {
    async first(query) {
      const [result] = await search(query);
      return result && page(result);
    },
    async pages() {
      return Promise.all((await search(null)).map(page));
    },
  };
}

/** Text as an index holds it: entities decoded, runs of white space as one space. */
function plain(text: string) {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The chrome of a built docs page, as texts no page's own content holds: the header's
 * links carry the dotless ı of the wordmark and a ★, where the nav's "Docs" would not do.
 */
export async function chromeOf(html: string): Promise<string[]> {
  const texts: string[] = [];
  await new HTMLRewriter()
    .on(".skip, header .mark, header .repo, footer p, nav.sidebar summary, nav.sidebar label", {
      element() {
        texts.push("");
      },
      text(chunk) {
        texts[texts.length - 1] += chunk.text;
      },
    })
    .transform(new Response(html))
    .text();
  return texts.map(plain).filter(Boolean);
}

/** What the index gets wrong, one line each: a query that lands elsewhere, chrome indexed. */
export async function searchProblems(
  index: Index,
  queries: readonly Expected[],
  chrome: readonly string[],
): Promise<string[]> {
  const problems: string[] = [];
  for (const { query, url } of queries) {
    const found = (await index.first(query))?.url;
    if (found !== url) problems.push(`"${query}" finds ${found ?? "nothing"} first, not ${url}`);
  }
  for (const page of await index.pages()) {
    const content = plain(page.content);
    for (const text of chrome)
      if (content.includes(text)) problems.push(`${page.url} indexes the chrome "${text}"`);
  }
  if (chrome.length === 0) problems.push("no chrome read from /docs/: nothing checked");
  return problems;
}

if (import.meta.main) {
  const dist = resolve(process.argv[2] ?? "dist");
  const chrome = await chromeOf(readFileSync(join(dist, "docs", "index.html"), "utf8"));
  const problems = await searchProblems(await openIndex(dist), QUERIES, chrome);
  if (problems.length > 0) {
    console.error(`check-search: ${problems.length} problem${problems.length === 1 ? "" : "s"}\n`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(
    `check-search: the ${QUERIES.length} queries find their page first; ` +
      `no page indexes the ${chrome.length} texts of the chrome.`,
  );
}
