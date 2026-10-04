/**
 * The check on the HTML the site ships, run on dist/ after `astro build`: a page that breaks
 * one of these rules fails the build.
 *   bun scripts/check-html.ts [dist]
 *
 * On every page:
 *   - an internal link, and the #anchor it carries, points at a page, a file or an id that exists;
 *   - there is exactly one h1, no heading level is skipped, and one `main#main`;
 *   - the first focusable element is a skip link to #main, with a text;
 * and on an indexable page (no noindex), a canonical, an og:url and an og:image on the site's
 * domain (`site` of astro.config.mjs), the first two being the page's own address, and a place
 * in the sitemap.
 *
 * Two things are set aside, each by name below: the cards photographed into a picture, which
 * are not documents, and the links into what `bun run demo` builds apart from the site.
 *
 * The pages are read as the browser reads them, in one pass each, with Bun's HTMLRewriter.
 * Focusable means what Tab stops on: links, buttons, form fields, summaries, tabindex >= 0
 * (an element with the `hidden` attribute is not).
 */
/// <reference types="bun" />

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import config from "../astro.config.mjs";

const { site } = z.object({ site: z.string().url() }).parse(config);
const origin = new URL(site).origin;

const FOCUSABLE = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  'input:not([type="hidden"]):not([disabled])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "summary",
  "[tabindex]",
  "[contenteditable]",
].join(",");

/** Pages that are a picture to photograph (scripts/og.ts), not a document: no heading, no main. */
const CARDS = new Set(["/og/", "/lab/mascot-og/"]);

/**
 * What `bun run demo` writes into public/demo/, apart from `astro build` (it is git-ignored):
 * its links are checked when the build holds it, and counted as skipped when it does not.
 */
const BUILT_APART = "/demo/";

interface Page {
  /** The address the page answers at, on the site: `/docs/`, `/404.html`. */
  path: string;
  ids: Set<string>;
  links: string[];
  headings: number[];
  mains: Array<string | undefined>;
  firstFocusable?: { tag: string; href?: string; text: string };
  noindex: boolean;
  canonicals: string[];
  ogUrls: string[];
  ogImages: string[];
}

/** The pages' files, relative to the build directory, in a stable order. */
function htmlFiles(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? htmlFiles(join(dir, entry.name), base)
        : entry.name.endsWith(".html")
          ? [relative(base, join(dir, entry.name))]
          : [],
    )
    .sort();
}

/** `docs/index.html` is answered at `/docs/`, `404.html` at `/404.html`. */
function addressOf(file: string) {
  return file.endsWith("index.html") ? `/${file.slice(0, -"index.html".length)}` : `/${file}`;
}

async function read(file: string, html: string): Promise<Page> {
  const page: Page = {
    path: addressOf(file),
    ids: new Set(),
    links: [],
    headings: [],
    mains: [],
    noindex: false,
    canonicals: [],
    ogUrls: [],
    ogImages: [],
  };
  let collecting: Page["firstFocusable"];
  const rewriter = new HTMLRewriter()
    .on("[id]", {
      element(element) {
        page.ids.add(element.getAttribute("id") ?? "");
      },
    })
    .on("a[name]", {
      element(element) {
        page.ids.add(element.getAttribute("name") ?? "");
      },
    })
    .on("a[href]", {
      element(element) {
        page.links.push(element.getAttribute("href") ?? "");
      },
    })
    .on("h1,h2,h3,h4,h5,h6", {
      element(element) {
        page.headings.push(Number(element.tagName.slice(1)));
      },
    })
    .on("main", {
      element(element) {
        page.mains.push(element.getAttribute("id") ?? undefined);
      },
    })
    .on(FOCUSABLE, {
      element(element) {
        const tabindex = element.getAttribute("tabindex");
        if (element.hasAttribute("hidden") || (tabindex !== null && Number(tabindex) < 0)) return;
        if (page.firstFocusable) return;
        const first = {
          tag: element.tagName,
          href: element.getAttribute("href") ?? undefined,
          text: "",
        };
        page.firstFocusable = first;
        collecting = first;
        element.onEndTag(() => {
          collecting = undefined;
        });
      },
      text(chunk) {
        if (collecting) collecting.text += chunk.text;
      },
    })
    .on("meta[name='robots']", {
      element(element) {
        if (/noindex/i.test(element.getAttribute("content") ?? "")) page.noindex = true;
      },
    })
    .on("link[rel='canonical']", {
      element(element) {
        page.canonicals.push(element.getAttribute("href") ?? "");
      },
    })
    .on("meta[property='og:url']", {
      element(element) {
        page.ogUrls.push(element.getAttribute("content") ?? "");
      },
    })
    .on("meta[property='og:image']", {
      element(element) {
        page.ogImages.push(element.getAttribute("content") ?? "");
      },
    });
  await rewriter.transform(new Response(html)).text();
  return page;
}

/** The addresses the sitemap lists, read from the index and the files it names. */
function sitemapAddresses(dist: string) {
  const index = join(dist, "sitemap-index.xml");
  if (!existsSync(index)) return undefined;
  const locs = (xml: string) =>
    [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1] ?? "");
  const addresses = new Set<string>();
  for (const sitemap of locs(readFileSync(index, "utf8"))) {
    const file = join(dist, new URL(sitemap).pathname);
    if (existsSync(file)) for (const loc of locs(readFileSync(file, "utf8"))) addresses.add(loc);
  }
  return addresses;
}

const dist = resolve(process.argv[2] ?? join(import.meta.dirname, "../dist"));
if (!existsSync(dist)) {
  console.error(`check-html: ${dist} does not exist, run \`astro build\` first.`);
  process.exit(1);
}

const files = htmlFiles(dist);
const pages = new Map<string, Page>();
const pageOf = new Map<string, string>();
await Promise.all(
  files.map(async (file) => {
    const page = await read(file, readFileSync(join(dist, file), "utf8"));
    pages.set(page.path, page);
    pageOf.set(file, page.path);
  }),
);

const problems: string[] = [];
const report = (page: Page, message: string) => problems.push(`${page.path}: ${message}`);

/** The page a path is served from: the directory's index, the file itself, or `path.html`. */
function target(pathname: string): { page?: Page; file?: string } | undefined {
  if (pathname.endsWith("/")) return { page: pages.get(pathname) };
  const file = join(dist, pathname);
  if (existsSync(file) && statSync(file).isFile()) return { page: pages.get(pathname), file };
  const served = [`${pathname}/`, `${pathname}.html`].map((path) => pages.get(path)).find(Boolean);
  return served ? { page: served } : undefined;
}

let skipped = 0;

function checkLink(page: Page, href: string) {
  if (
    /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href) &&
    !href.startsWith(`${origin}/`) &&
    href !== origin
  )
    return;
  const url = new URL(href, `${origin}${page.path}`);
  if (url.origin !== origin) return;
  const pathname = decodeURIComponent(url.pathname);
  if (pathname.startsWith(BUILT_APART) && !existsSync(join(dist, BUILT_APART))) {
    skipped += 1;
    return;
  }
  const found = target(pathname);
  if (!found || (!found.page && !found.file))
    return report(page, `link to ${href} points at nothing`);
  const anchor = decodeURIComponent(url.hash.slice(1));
  if (!anchor || anchor.toLowerCase() === "top" || !found.page) return;
  if (!found.page.ids.has(anchor))
    report(page, `link to ${href}: no #${anchor} on ${found.page.path}`);
}

function checkStructure(page: Page) {
  const h1 = page.headings.filter((level) => level === 1).length;
  if (h1 !== 1) report(page, `${h1} h1, expected one`);
  page.headings.forEach((level, i) => {
    const before = page.headings[i - 1];
    if (before !== undefined && level > before + 1) report(page, `h${level} follows h${before}`);
  });
  if (page.mains.length !== 1 || page.mains[0] !== "main") {
    report(
      page,
      `expected one <main id="main">, found ${page.mains.map((id) => `main#${id ?? ""}`).join(", ") || "none"}`,
    );
  }
  const first = page.firstFocusable;
  if (first?.href !== "#main" || !first.text.trim()) {
    report(
      page,
      `the first focusable element is ${first ? `<${first.tag} href="${first.href ?? ""}">` : "missing"}, expected a skip link to #main`,
    );
  }
}

function checkIndexable(page: Page, sitemap: Set<string> | undefined) {
  const own = new URL(page.path, origin).href;
  const only = (name: string, values: string[], expected?: string) => {
    if (values.length !== 1) return report(page, `${values.length} ${name}, expected one`);
    const [value = ""] = values;
    if (!value.startsWith(`${origin}/`)) report(page, `${name} ${value} is not on ${origin}/`);
    else if (expected && value !== expected) report(page, `${name} ${value}, expected ${expected}`);
  };
  only("canonical", page.canonicals, own);
  only("og:url", page.ogUrls, own);
  only("og:image", page.ogImages);
  if (!sitemap) return;
  if (!sitemap.has(own)) report(page, "missing from the sitemap");
}

const sitemap = sitemapAddresses(dist);
const indexable = [...pages.values()].filter((page) => !page.noindex);
if (indexable.length > 0 && !sitemap) problems.push("sitemap-index.xml is missing from the build");
for (const page of [...pages.values()].sort((a, b) => a.path.localeCompare(b.path))) {
  if (!CARDS.has(page.path)) {
    for (const href of new Set(page.links)) checkLink(page, href);
    checkStructure(page);
  }
  if (!page.noindex) checkIndexable(page, sitemap);
}

if (problems.length > 0) {
  console.error(
    `check-html: ${problems.length} problem${problems.length === 1 ? "" : "s"} in the built site\n`,
  );
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
const note = skipped > 0 ? ` (${skipped} links into ${BUILT_APART} skipped: not built)` : "";
console.log(`check-html: ${pages.size} pages, no problem${note}.`);
