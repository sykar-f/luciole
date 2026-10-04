import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// The check on the built site (website/scripts/check-html.ts), run on a small `dist` written
// here, given the site's origin (the script reads astro.config.mjs without it, which needs
// the website's own install): one good page that every case starts from, and one change per rule.
const root = resolve(import.meta.dir, "..");
const site = "https://luciole.sh";
const directories: string[] = [];
afterAll(() => directories.forEach((directory) => rmSync(directory, { recursive: true })));

interface Options {
  /** What goes in the body after the skip link, inside `<main id="main">`. */
  body?: string;
  /** The tags of the head; the page's own canonical, og:url and og:image by default. */
  head?: string;
  /** Replaces the skip link, the first thing of the body. */
  skip?: string;
}

const head = (path: string) =>
  `<link rel="canonical" href="${site}${path}"><meta property="og:url" content="${site}${path}"><meta property="og:image" content="${site}/og.png">`;

function page(path: string, { body = "<h1>Docs</h1>", head: tags, skip }: Options = {}) {
  const link = skip ?? '<a class="skip" href="#main">Skip to content</a>';
  return `<!doctype html><html lang="en"><head><title>t</title>${tags ?? head(path)}</head><body>${link}<main id="main">${body}</main></body></html>`;
}

/** Writes a build with the given pages (by address) and a sitemap of `listed`, then checks it. */
async function check(pages: Record<string, string>, listed = Object.keys(pages)) {
  const dist = mkdtempSync(join(tmpdir(), "check-html-"));
  directories.push(dist);
  const write = (file: string, content: string) => {
    mkdirSync(dirname(join(dist, file)), { recursive: true });
    writeFileSync(join(dist, file), content);
  };
  for (const [path, html] of Object.entries(pages)) write(`${path}index.html`.slice(1), html);
  write("og.png", "");
  write(
    "sitemap-index.xml",
    `<sitemapindex><sitemap><loc>${site}/sitemap-0.xml</loc></sitemap></sitemapindex>`,
  );
  write(
    "sitemap-0.xml",
    `<urlset>${listed
      .filter((path) => path in pages)
      .map((path) => `<url><loc>${site}${path}</loc></url>`)
      .join("")}</urlset>`,
  );
  const child = Bun.spawn([process.execPath, "website/scripts/check-html.ts", dist, site], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, out, err };
}

const home = page("/", { body: '<h1>Home</h1><a href="/docs/#start">Docs</a>' });
const docs = page("/docs/", { body: '<h1>Docs</h1><h2 id="start">Start</h2><a href="/">Home</a>' });
const good = { "/": home, "/docs/": docs };

describe("a build the rules hold on", () => {
  test("passes", async () => {
    const { code, out } = await check(good);
    expect(out).toContain("no problem");
    expect(code).toBe(0);
  });

  test("links to files, other sites and the top of a page are fine", async () => {
    const body =
      '<h1>Docs</h1><h2 id="start">Start</h2><a href="/og.png">card</a><a href="https://example.com/x">out</a><a href="mailto:a@b.c">m</a><a href="#top">top</a><a href="#main">main</a>';
    const { code } = await check({ ...good, "/docs/": page("/docs/", { body }) });
    expect(code).toBe(0);
  });
});

describe("a page that breaks a rule fails the build", () => {
  const cases: Array<[string, Options, RegExp]> = [
    [
      "a link to a missing page",
      { body: '<h1>A</h1><a href="/nowhere/">x</a>' },
      /link to \/nowhere\/ points at nothing/,
    ],
    ["a link to a missing anchor", { body: '<h1>A</h1><a href="/#nope">x</a>' }, /no #nope on \//],
    [
      "a link with a malformed escape",
      { body: '<h1>A</h1><a href="/docs/%zz">x</a>' },
      /points at nothing/,
    ],
    ["two h1", { body: "<h1>A</h1><h1>B</h1>" }, /2 h1, expected one/],
    ["no h1", { body: "<h2>A</h2>" }, /0 h1, expected one/],
    ["a skipped heading level", { body: "<h1>A</h1><h3>B</h3>" }, /h3 follows h1/],
    ["no skip link", { skip: '<a href="/">Home</a>' }, /first focusable element is <a href="\/">/],
    ["a skip link with no text", { skip: '<a href="#main"></a>' }, /expected a skip link to #main/],
    [
      "a canonical on another host",
      {
        head: `<link rel="canonical" href="https://example.com/x/"><meta property="og:url" content="${site}/x/"><meta property="og:image" content="${site}/og.png">`,
      },
      /canonical https:\/\/example\.com\/x\/ is not on/,
    ],
    [
      "an og:image missing",
      {
        head: `<link rel="canonical" href="${site}/x/"><meta property="og:url" content="${site}/x/">`,
      },
      /0 og:image, expected one/,
    ],
  ];
  for (const [name, options, message] of cases) {
    test(name, async () => {
      const { code, err } = await check({ ...good, "/x/": page("/x/", options) });
      expect(err).toMatch(message);
      expect(err).toContain("/x/:");
      expect(code).toBe(1);
    });
  }

  test("a page with no main#main", async () => {
    const html = page("/x/").replace('<main id="main">', "<main>");
    const { code, err } = await check({ ...good, "/x/": html });
    expect(err).toMatch(/expected one <main id="main">, found main#/);
    expect(code).toBe(1);
  });

  test("a page missing from the sitemap", async () => {
    const { code, err } = await check({ ...good, "/x/": page("/x/") }, ["/", "/docs/"]);
    expect(err).toContain("/x/: missing from the sitemap");
    expect(code).toBe(1);
  });
});

describe("what is not a document of the site", () => {
  const application =
    "<!doctype html><html><head><title>demo</title></head><body><div id=app></div></body></html>";

  test("a noindex page needs no canonical, nor a place in the sitemap", async () => {
    const noindex = page("/x/", { head: '<meta name="robots" content="noindex">' });
    const { code } = await check({ ...good, "/x/": noindex });
    expect(code).toBe(0);
  });

  test("a demo application is exempt, and the links into it are checked", async () => {
    const link = (href: string) => page("/", { body: `<h1>Home</h1><a href="${href}">demo</a>` });
    const green = await check({
      "/": link("/demo/notes/"),
      "/demo/notes/": application,
      "/docs/": docs,
    });
    expect(green.out).toContain("no problem");
    expect(green.code).toBe(0);
    const red = await check({
      "/": link("/demo/other/"),
      "/demo/notes/": application,
      "/docs/": docs,
    });
    expect(red.err).toContain("link to /demo/other/ points at nothing");
    expect(red.code).toBe(1);
  });

  test("links into demos that were not built are skipped, and counted", async () => {
    const body = '<h1>Home</h1><a href="/demo/notes/">demo</a>';
    const { code, out } = await check({ "/": page("/", { body }), "/docs/": docs });
    expect(out).toContain("1 links into /demo/ skipped");
    expect(code).toBe(0);
  });
});
