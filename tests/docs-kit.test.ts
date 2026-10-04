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

/** A screen of the capture `title`, set in its bar as Screen sets it, described by `id`. */
const titled = (title: string, id: string) =>
  screen(title, "Welcome")
    .replace('aria-describedby="s1"', `aria-describedby="${id}"`)
    .replace('id="s1"', `id="${id}"`)
    .replace(
      'data-figure="screen">',
      `data-figure="screen"><div class="bar"><span class="title"><b>┤</b> ${title} <b>├</b></span></div>`,
    );

/** A screen marked 1 to 3, with `legend` after its caption. */
const marked = (legend: string, marks = "1 2 3") =>
  screen("Notes, marked", "Welcome")
    .replace('data-figure="screen">', `data-figure="screen" data-marks="${marks}">`)
    .replace("</figcaption>", `</figcaption><div class="legend" data-legend>${legend}</div>`);
const legend = "<ol><li>The list</li><li>The note</li><li>The status</li></ol>";
/** The same screen, its regions drawn on `sides`: one Client or Server per mark, in order. */
const sided = (legend: string, sides = ["client", "server", "client"]) =>
  marked(legend).replace(
    '<div class="screen" role="img" aria-label="Notes" aria-describedby="s1">',
    `$&${sides.map((side, i) => `<span class="region ${side}" data-region="${i + 1}"></span>`).join("")}`,
  );
const said =
  "<ol><li>The Client's list</li><li>The note, from the <b>Server</b></li><li>The status, on the Client, not the Server</li></ol>";

const sequence = (steps: string) => `
  <figure data-figure="sequence"><svg role="img" aria-describedby="q"></svg>
    <figcaption>A click</figcaption><details><div id="q">${steps}</div></details></figure>`;

const run = (extra: string) => `<div data-figure="run-here"><div data-live data-boot="manual"
  data-src="/demo/notes/index.html"></div></div>${extra}`;

/** A RunHere starting from a round trip of `latency` ms, with `control` in its figure. */
const timed = (control: string, latency = "500") => `<div data-figure="run-here"
  data-latency="${latency}"><div data-live data-boot="manual" data-src="/demo/latency/index.html">
  </div>${control}</div>`;
const slider = (bounds = 'min="0" max="2000"', shown = "500 ms") =>
  `<input type="range" ${bounds} value="500"><output>${shown}</output>`;
const labelled = (inside = slider()) => `<label>Round trip to the Server${inside}</label>`;

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

  test("a docs page that shows one capture twice, and the landing's duel", async () => {
    const twice =
      titled("Notes: the first note open", "s1") + titled("Notes: the first note open", "s2");
    expect(await problems(twice)).toEqual([
      '/docs/a/: screen "Notes: the first note open": shows the capture "Notes: the first note open" a second time',
    ]);
    expect(
      await problems(
        titled("Notes: the first note open", "s1") + titled("Notes: the Server gone", "s2"),
      ),
    ).toEqual([]);
    expect(await problems(twice, "/")).toEqual([]);
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

  test("a legend item may hold a list of its own: only the legend's items count", async () => {
    const nested = legend.replace("<li>The note", "<li>The note<ol><li>its title</li></ol>");
    expect(await problems(marked(nested))).toEqual([]);
  });

  test("a legend item that names no side, or the other one first", async () => {
    expect(await problems(sided(said))).toEqual([]);
    expect(await problems(sided(said, ["client", "server", "server"]))).toEqual([
      `/docs/a/: screen "Notes, marked": legend item 3 names the Client first: its region is the Server's`,
    ]);
    expect(await problems(sided(legend))).toEqual([
      `/docs/a/: screen "Notes, marked": legend item 1 names no side: its region is the Client's`,
      `/docs/a/: screen "Notes, marked": legend item 2 names no side: its region is the Server's`,
      `/docs/a/: screen "Notes, marked": legend item 3 names no side: its region is the Client's`,
    ]);
    // A word, not a part of one: `client notes 4101` on the screen is not the side.
    expect(await problems(sided(said.replace("The Client's list", "The clients' list")))).toEqual([
      `/docs/a/: screen "Notes, marked": legend item 1 names no side: its region is the Client's`,
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

  test("an excerpt whose side is colour only, or not in English", async () => {
    const excerpt = (side: string) =>
      `<figure data-figure="excerpt" data-tone="wire"><div class="bar"><a>page.tsx</a>${side}</div></figure>`;
    expect(await problems(excerpt(""))).toEqual([
      '/docs/a/: excerpt "": its side reads "", not Wire',
    ]);
    expect(await problems(excerpt('<span class="side">Wire</span>'))).toEqual([]);
    expect(await problems(excerpt('<span class="side">Réseau</span>'))).toEqual([
      '/docs/a/: excerpt "": its side reads "Réseau", not Wire',
    ]);
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

  test("a RunHere's round-trip slider, there exactly when it has a latency", async () => {
    expect(await problems(timed(labelled()))).toEqual([]);
    expect(await problems(timed(""))).toEqual([
      '/docs/a/: run-here "": latency="500", and no round-trip slider',
    ]);
    const unset = timed(labelled()).replace(/\s*data-latency="500"/, "");
    expect(await problems(unset)).toEqual([
      '/docs/a/: run-here "": a round-trip slider, and no latency to start it from',
    ]);
    // A slider of the page's own, outside the figure, is not the RunHere's.
    expect(await problems(run(labelled()))).toEqual([]);
  });

  test("a round-trip slider without a name, a unit or bounds the network takes", async () => {
    expect(await problems(timed(slider()))).toEqual([
      '/docs/a/: run-here "": its round-trip slider has no label',
    ]);
    // Named for a screen reader only: the reader who sees it does not know what it sets.
    const unseen = timed(slider().replace("<input", '<input aria-label="Round trip"'));
    expect(await problems(unseen)).toEqual([
      '/docs/a/: run-here "": its round-trip slider has no label',
    ]);
    expect(await problems(timed(labelled(slider('min="0" max="2000"', "500"))))).toEqual([
      '/docs/a/: run-here "": its round-trip slider shows no value in ms',
    ]);
    expect(await problems(timed(labelled(slider('min="0" max="20000"'))))).toEqual([
      '/docs/a/: run-here "": its round trip goes from 0 to 20000 ms, beyond the network command\'s 0 to 10000',
    ]);
    expect(await problems(timed(labelled(), "3000"))).toEqual([
      '/docs/a/: run-here "": its latency, 3000 ms, is off its slider\'s 0 to 2000',
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

  test("fails a page that shows one capture twice", async () => {
    const { code, err } = await build(titled("Notes", "s1") + titled("Notes", "s2"));
    expect(err).toContain('/docs/: screen "Notes": shows the capture "Notes" a second time');
    expect(code).toBe(1);
  });

  test("fails a page with a marked screen that has no legend", async () => {
    const { code, err } = await build(marked(""));
    expect(err).toContain(
      '/docs/: screen "Notes, marked": no legend: an ordered list of its marks',
    );
    expect(code).toBe(1);
  });

  test("fails a page with a marked screen whose legend names no side", async () => {
    const { code, err } = await build(sided(legend));
    expect(err).toContain(
      `/docs/: screen "Notes, marked": legend item 2 names no side: its region is the Server's`,
    );
    expect(code).toBe(1);
  });
});
