import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { kitProblems } from "../website/scripts/check-kit.ts";

// The contracts of the docs' figure kit (website/scripts/check-kit.ts), on pages written
// here: each rule red on a page that breaks it, and the build's check (check-html.ts, run
// after `astro build`) failing on such a page.
const root = resolve(import.meta.dir, "..");
const site = "https://luciole.sh";
const directories: string[] = [];
afterAll(() => directories.forEach((directory) => rmSync(directory, { recursive: true })));

const problems = async (html: string, page = "/docs/a/") =>
  (await kitProblems(html, page)).problems;

const screen = (caption: string, transcript: string) => `
  <figure data-figure="screen">
    <div class="screen" role="img" aria-label="Notes" aria-describedby="s1"></div>
    <figcaption>${caption}</figcaption>
    <details><summary>Transcript</summary><pre id="s1" data-transcript>${transcript}</pre></details>
  </figure>`;

/** A screen marked 1 to 3, with `legend` after its caption. */
const marked = (legend: string, marks = "1 2 3") =>
  screen("Notes, marked", "Welcome")
    .replace('data-figure="screen">', `data-figure="screen" data-marks="${marks}">`)
    .replace("</figcaption>", `</figcaption><div class="legend">${legend}</div>`);
const legend = "<ol><li>The list</li><li>The note</li><li>The status</li></ol>";

const sequence = (steps: string) => `
  <figure data-figure="sequence"><svg role="img" aria-describedby="q"></svg>
    <figcaption>A click</figcaption><details><div id="q">${steps}</div></details></figure>`;

const run = (extra: string) => `<div data-figure="run-here"><div data-live data-boot="manual"
  data-src="/demo/notes/index.html"></div></div>${extra}`;

describe("the figure kit's contracts", () => {
  test("hold on a captioned, transcribed screen and a listed sequence", async () => {
    const html =
      screen("Notes, open", " ╭──╮ Welcome") + sequence("<ol><li>Client → Server</li></ol>");
    expect(await kitProblems(html, "/docs/a/")).toEqual({ problems: [], figures: 2 });
  });

  test("a screen without a caption or a transcript", async () => {
    expect(await problems(screen(" ", "Welcome"))).toEqual(['/docs/a/: screen "": no caption']);
    expect(await problems(screen("Notes", ""))).toEqual([
      '/docs/a/: screen "Notes": no transcript',
    ]);
  });

  test("a screen described by something else, or by an id two elements share", async () => {
    const elsewhere = screen("Notes", "Welcome").replace(
      'aria-describedby="s1"',
      'aria-describedby="s2"',
    );
    expect(await problems(`${elsewhere}<p id="s2"></p>`)).toEqual([
      '/docs/a/: screen "Notes": its description is not its transcript',
    ]);
    expect(await problems(screen("Notes", "Welcome").repeat(2))).toEqual([
      '/docs/a/: screen "Notes": aria-describedby="s1" names 2 elements',
      '/docs/a/: screen "Notes": aria-describedby="s1" names 2 elements',
    ]);
  });

  test("a marked screen whose legend numbers each mark, and one without it", async () => {
    expect(await problems(marked(legend))).toEqual([]);
    expect(await problems(marked(""))).toEqual([
      '/docs/a/: screen "Notes, marked": no legend: an ordered list of its marks',
    ]);
    expect(await problems(marked("<ol><li>The list</li><li>The note</li></ol>"))).toEqual([
      '/docs/a/: screen "Notes, marked": 3 marks for 2 legend items',
    ]);
    expect(await problems(marked(legend, "2 3 4"))).toEqual([
      '/docs/a/: screen "Notes, marked": its marks 2 3 4 are not numbered from 1',
    ]);
  });

  test("a mark with no blank cells beside its region", async () => {
    const crowded = marked(legend).replace(
      'data-marks="1 2 3"',
      'data-marks="1 2 3" data-unplaced="2"',
    );
    expect(await problems(crowded)).toEqual([
      '/docs/a/: screen "Notes, marked": mark 2 has no blank cells beside its region: it would hide the screen',
    ]);
  });

  test("a sequence without the list of its steps", async () => {
    expect(await problems(sequence(""))).toEqual([
      '/docs/a/: sequence "A click": no ordered list of its steps',
    ]);
  });

  test("an excerpt whose side is colour only, in the docs and in the French guide", async () => {
    const excerpt = (side: string) =>
      `<figure data-figure="excerpt" data-tone="wire"><div class="bar"><a>page.tsx</a>${side}</div></figure>`;
    expect(await problems(excerpt(""))).toEqual([
      '/docs/a/: excerpt "": its side reads "", not Wire',
    ]);
    expect(await problems(excerpt('<span class="side">Wire</span>'))).toEqual([]);
    expect(await problems(excerpt('<span class="side">Réseau</span>'), "/guide/a/")).toEqual([]);
  });

  test("an annotated capture whose marks and notes disagree", async () => {
    const capture = `<figure data-figure="capture"><pre><code><mark data-n="1">1:R</mark></code></pre>
      <figcaption>The answer.</figcaption><ol><li>one</li><li>two</li></ol></figure>`;
    expect(await problems(capture)).toEqual([
      '/docs/a/: capture "The answer.": 1 marks for 2 notes',
    ]);
  });

  test("a RunHere page that fetches its demo before the click", async () => {
    expect(await problems(run(""))).toEqual([]);
    expect(await problems(run('<link rel="prefetch" href="/demo/notes/index.html">'))).toEqual([
      '/docs/a/: run-here "": the page fetches a demo before the click: <link rel="prefetch" href="/demo/notes/index.html">',
    ]);
    expect(await problems(run('<iframe src="/demo/notes/index.html"></iframe>'))).toEqual([
      '/docs/a/: run-here "": the page fetches a demo before the click: <iframe src="/demo/notes/index.html">',
      '/docs/a/: run-here "": the page fetches a demo before the click: <iframe>',
    ]);
    expect(await problems(run("").replace('data-boot="manual"', 'data-boot="visible"'))).toEqual([
      '/docs/a/: run-here "": its demo does not wait for a click',
    ]);
  });
});

describe("the build's check", () => {
  /** A one-page build that holds check-html's own rules, with `figures` in its main. */
  async function build(figures: string) {
    const dist = mkdtempSync(join(tmpdir(), "docs-kit-"));
    directories.push(dist);
    const write = (file: string, content: string) => {
      mkdirSync(dirname(join(dist, file)), { recursive: true });
      writeFileSync(join(dist, file), content);
    };
    write(
      "docs/index.html",
      `<!doctype html><html lang="en"><head><title>t</title><link rel="canonical" href="${site}/docs/"><meta property="og:url" content="${site}/docs/"><meta property="og:image" content="${site}/og.png"></head><body><a class="skip" href="#main">Skip to content</a><main id="main"><h1>Docs</h1>${figures}</main></body></html>`,
    );
    write("og.png", "");
    write(
      "sitemap-index.xml",
      `<sitemapindex><sitemap><loc>${site}/sitemap-0.xml</loc></sitemap></sitemapindex>`,
    );
    write("sitemap-0.xml", `<urlset><url><loc>${site}/docs/</loc></url></urlset>`);
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

  test("passes a page whose figures hold, and says how many it checked", async () => {
    const { code, out } = await build(screen("Notes, open", "Welcome"));
    expect(out).toContain(
      "check-html: 1 figures of the kit (scripts/check-kit.ts) hold their contracts.",
    );
    expect(code).toBe(0);
  });

  test("fails a page with a screen that has no caption", async () => {
    const { code, err } = await build(screen("", "Welcome"));
    expect(err).toContain('/docs/: screen "": no caption');
    expect(code).toBe(1);
  });

  test("fails a page with a marked screen that has no legend", async () => {
    const { code, err } = await build(marked(""));
    expect(err).toContain(
      '/docs/: screen "Notes, marked": no legend: an ordered list of its marks',
    );
    expect(code).toBe(1);
  });
});
