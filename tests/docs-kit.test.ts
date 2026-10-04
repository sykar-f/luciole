import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

// The contracts of the docs' visual kit (website/README.md, "Les composants des docs"), on
// the site as built: every screen captioned and transcribed, every sequence captioned and
// listed as text, every excerpt with a side naming it in words, every annotated capture
// with a note per mark, and no demo of a RunHere loaded before the reader's click. The
// site is built afresh into a temporary directory: a stale dist/ proves nothing.
const root = join(import.meta.dir, "..");
const website = join(root, "website");
const astro = join(website, "node_modules/.bin/astro");

type Figure = {
  kind: string;
  tone?: string;
  caption: string;
  describedBy: string[];
  transcripts: { id: string; text: string }[];
  side: string;
  items: number;
  lists: number;
  marks: number;
  boot: string[];
};

const SIDES: Record<string, string> = {
  client: "Client",
  server: "Server",
  wire: "Wire",
  build: "Build",
};
const SIDES_FR: Record<string, string> = { ...SIDES, wire: "Réseau" };

/** What a page's HTML breaks of the kit's contracts, one line each; none when it holds. */
export async function kitProblems(html: string, page: string) {
  const figures: Figure[] = [];
  const open: Figure[] = [];
  const ids = new Map<string, number>();
  const demo: string[] = [];
  let text: ((chunk: string) => void) | undefined;
  const inner = () => open.at(-1);
  const count = (what: "lists" | "items" | "marks") => {
    const figure = inner();
    if (figure) figure[what] += 1;
  };
  // Text read into the innermost figure while `read` is open.
  const read = (into: (figure: Figure, chunk: string) => void) => ({
    element(element: HTMLRewriterTypes.Element) {
      const figure = inner();
      if (!figure) return;
      text = (chunk) => into(figure, chunk);
      element.onEndTag(() => {
        text = undefined;
      });
    },
    text(chunk: HTMLRewriterTypes.Text) {
      text?.(chunk.text);
    },
  });

  new HTMLRewriter()
    .on("[data-figure]", {
      element(element) {
        const figure: Figure = {
          kind: element.getAttribute("data-figure") ?? "",
          tone: element.getAttribute("data-tone") ?? undefined,
          caption: "",
          describedBy: [],
          transcripts: [],
          side: "",
          items: 0,
          lists: 0,
          marks: 0,
          boot: [],
        };
        figures.push(figure);
        open.push(figure);
        element.onEndTag(() => {
          open.pop();
        });
      },
    })
    .on(
      "figcaption",
      read((figure, chunk) => (figure.caption += chunk)),
    )
    .on(
      ".side",
      read((figure, chunk) => (figure.side += chunk)),
    )
    .on("[data-transcript]", {
      element(element) {
        const figure = inner();
        if (!figure) return;
        const transcript = { id: element.getAttribute("id") ?? "", text: "" };
        figure.transcripts.push(transcript);
        text = (chunk) => (transcript.text += chunk);
        element.onEndTag(() => {
          text = undefined;
        });
      },
      text(chunk) {
        text?.(chunk.text);
      },
    })
    .on("[aria-describedby]", {
      element(element) {
        inner()?.describedBy.push(element.getAttribute("aria-describedby") ?? "");
      },
    })
    .on("ol", { element: () => count("lists") })
    .on("li", { element: () => count("items") })
    .on("mark[data-n]", { element: () => count("marks") })
    .on("[data-boot]", {
      element(element) {
        inner()?.boot.push(element.getAttribute("data-boot") ?? "");
      },
    })
    .on("[id]", {
      element(element) {
        const id = element.getAttribute("id") ?? "";
        ids.set(id, (ids.get(id) ?? 0) + 1);
      },
    })
    // What would fetch a demo with the page: a frame or script source, a hint to fetch it.
    .on("[src]", {
      element(element) {
        const src = element.getAttribute("src") ?? "";
        if (src.includes("/demo/")) demo.push(`<${element.tagName} src="${src}">`);
      },
    })
    .on("link[rel]", {
      element(element) {
        const rel = element.getAttribute("rel") ?? "";
        const href = element.getAttribute("href") ?? "";
        if (/preload|prefetch|prerender/.test(rel) && href.includes("/demo/"))
          demo.push(`<link rel="${rel}" href="${href}">`);
      },
    })
    .on("iframe", { element: () => void demo.push("<iframe>") })
    .on('script[type="speculationrules"]', {
      text(chunk) {
        if (chunk.text.includes("/demo/")) demo.push("speculation rules naming /demo/");
      },
    })
    .transform(html);

  const french = page.startsWith("guide/");
  const problems: string[] = [];
  const say = (figure: Figure, what: string) =>
    problems.push(
      `${page}: ${figure.kind} ${JSON.stringify(figure.caption.trim().slice(0, 50))}: ${what}`,
    );
  /** Each description points to one element of the page, as transcripts and lists need. */
  const described = (figure: Figure) => {
    if (figure.describedBy.length === 0) say(figure, "no aria-describedby");
    for (const id of figure.describedBy)
      if (ids.get(id) !== 1)
        say(figure, `aria-describedby="${id}" names ${ids.get(id) ?? 0} elements`);
  };
  for (const figure of figures) {
    const captioned = figure.caption.trim().length > 0;
    if (figure.kind === "screen") {
      if (!captioned) say(figure, "no caption");
      described(figure);
      const transcript = figure.transcripts[0];
      if (!transcript?.text.trim()) say(figure, "no transcript");
      else if (!figure.describedBy.includes(transcript.id))
        say(figure, "its description is not its transcript");
    }
    if (figure.kind === "sequence") {
      if (!captioned) say(figure, "no caption");
      described(figure);
      if (figure.lists === 0 || figure.items === 0) say(figure, "no ordered list of its steps");
    }
    if (figure.kind === "excerpt" && figure.tone && figure.tone !== "neutral") {
      const expected = (french ? SIDES_FR : SIDES)[figure.tone];
      if (figure.side.trim() !== expected)
        say(figure, `its side reads ${JSON.stringify(figure.side.trim())}, not ${expected}`);
    }
    if (figure.kind === "capture") {
      if (!captioned) say(figure, "no caption");
      if (figure.marks === 0 || figure.marks !== figure.items)
        say(figure, `${figure.marks} marks for ${figure.items} notes`);
    }
    if (figure.kind === "code-and-screen" && !captioned) say(figure, "no caption");
    if (figure.kind === "run-here") {
      if (!figure.boot.every((boot) => boot === "manual") || figure.boot.length === 0)
        say(figure, "its demo does not wait for a click");
      for (const fetch of demo) say(figure, `the page fetches a demo before the click: ${fetch}`);
    }
  }
  return problems;
}

const pages = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return pages(path);
    return entry.name.endsWith(".html") ? [path] : [];
  });

describe("the kit's check", () => {
  const screen = (caption: string, transcript: string) => `
    <figure data-figure="screen">
      <div class="screen" role="img" aria-label="Notes" aria-describedby="s1"></div>
      <figcaption>${caption}</figcaption>
      <details><summary>Transcript</summary><pre id="s1" data-transcript>${transcript}</pre></details>
    </figure>`;

  test("passes a captioned, transcribed screen", async () => {
    expect(await kitProblems(screen("Notes, open", " ╭──╮ Welcome"), "docs/a/index.html")).toEqual(
      [],
    );
  });

  test("fails a screen without a caption or a transcript", async () => {
    expect(await kitProblems(screen(" ", "Welcome"), "docs/a/index.html")).toEqual([
      'docs/a/index.html: screen "": no caption',
    ]);
    expect(await kitProblems(screen("Notes", ""), "docs/a/index.html")).toEqual([
      'docs/a/index.html: screen "Notes": no transcript',
    ]);
  });

  test("fails a sequence without its list, and an excerpt whose side is colour only", async () => {
    const sequence = `<figure data-figure="sequence"><svg role="img" aria-describedby="q"></svg>
      <figcaption>A click</figcaption><details><div id="q"></div></details></figure>`;
    expect(await kitProblems(sequence, "docs/a/index.html")).toEqual([
      'docs/a/index.html: sequence "A click": no ordered list of its steps',
    ]);
    const excerpt = `<figure data-figure="excerpt" data-tone="server"><div class="bar"><a>page.tsx</a></div></figure>`;
    expect(await kitProblems(excerpt, "docs/a/index.html")).toEqual([
      'docs/a/index.html: excerpt "": its side reads "", not Server',
    ]);
  });

  test("fails a RunHere whose page loads its demo before the click", async () => {
    const run = (extra: string) => `<div data-figure="run-here"><div data-live data-boot="manual"
      data-src="/demo/notes/index.html"></div></div>${extra}`;
    expect(await kitProblems(run(""), "docs/a/index.html")).toEqual([]);
    expect(
      await kitProblems(
        run('<link rel="prefetch" href="/demo/notes/index.html">'),
        "docs/a/index.html",
      ),
    ).toEqual([
      'docs/a/index.html: run-here "": the page fetches a demo before the click: <link rel="prefetch" href="/demo/notes/index.html">',
    ]);
    expect(
      await kitProblems(run('<iframe src="/demo/notes/index.html"></iframe>'), "docs/a/index.html"),
    ).toHaveLength(2);
  });
});

describe.skipIf(!existsSync(astro))("the site as built", () => {
  const out = mkdtempSync(join(tmpdir(), "luciole-site-"));
  let built: { path: string; html: string }[] = [];

  beforeAll(() => {
    const build = Bun.spawnSync([astro, "build", "--outDir", out], {
      cwd: website,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (build.exitCode !== 0) throw new Error(`astro build failed:\n${build.stderr.toString()}`);
    built = pages(out).map((path) => ({
      path: relative(out, path),
      html: readFileSync(path, "utf8"),
    }));
  }, 180_000);

  afterAll(() => rmSync(out, { recursive: true, force: true }));

  test("every page holds the kit's contracts", async () => {
    const problems = (
      await Promise.all(built.map(({ path, html }) => kitProblems(html, path)))
    ).flat();
    expect(problems).toEqual([]);
  });

  test("the kit is on the site: each component at least once", () => {
    const kinds = new Set(
      built.flatMap(({ html }) =>
        [...html.matchAll(/data-figure="([a-z-]+)"/g)].map(([, kind]) => kind),
      ),
    );
    expect([...kinds].toSorted()).toEqual([
      "capture",
      "code-and-screen",
      "excerpt",
      "run-here",
      "screen",
      "sequence",
    ]);
  });

  test("a RunHere page asks for nothing under /demo/ before the click", async () => {
    const page = built.find(({ path }) => path === "docs/concepts/client-and-server/index.html");
    expect(page?.html).toContain('data-figure="run-here"');
    expect(page?.html).not.toMatch(/\ssrc="[^"]*\/demo\//);
    expect(page?.html).not.toMatch(
      /<link[^>]*rel="[^"]*(preload|prefetch|prerender)[^"]*"[^>]*\/demo\//,
    );
    expect(page?.html).not.toContain("<iframe");
  });
});
