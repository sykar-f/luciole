/**
 * The contracts of the docs' figure kit (README.md, « Les composants des docs »), on a page
 * of the built site: every screen captioned and described by its transcript, every sequence
 * captioned and described by the ordered list of its steps, every excerpt that has a side
 * naming it in words, every annotated capture with a note per mark, and no demo of a RunHere
 * fetched before the reader's click. scripts/check-html.ts runs it on each page of dist/, so
 * a page that breaks one fails `bun run build`.
 */
/// <reference types="bun" />

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

/** How much of a figure's caption a problem quotes, to name the figure. */
const QUOTED = 50;

const SIDES: Record<string, string> = {
  client: "Client",
  server: "Server",
  wire: "Wire",
  build: "Build",
};
const SIDES_FR: Record<string, string> = { ...SIDES, wire: "Réseau" };

/**
 * What a page's HTML breaks of the kit's contracts, one line each, and how many figures it
 * holds. `page` is the page's address (`/docs/…/`), which says its language too.
 */
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

  const french = page.startsWith("/guide/");
  const problems: string[] = [];
  const say = (figure: Figure, what: string) =>
    problems.push(
      `${page}: ${figure.kind} ${JSON.stringify(figure.caption.trim().slice(0, QUOTED))}: ${what}`,
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
  return { problems, figures: figures.length };
}
