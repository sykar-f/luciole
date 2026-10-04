/**
 * The contracts of the docs' figure kit (README.md, « Les composants des docs »), on a page
 * of the built site: every screen captioned and described by its transcript, a marked screen
 * with a legend that numbers its marks and each number drawn beside its region, every
 * sequence captioned and described by the ordered list of its steps, every excerpt that has
 * a side naming it in words, every annotated capture with a note per mark, no demo of a
 * RunHere fetched before the reader's click, and a round-trip slider in a RunHere exactly when
 * it is given a `latency`, labelled and naming its unit. scripts/check-html.ts runs it on each
 * page of dist/, so a page that breaks one fails `bun run build`.
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
  /** A marked screen's region numbers (`data-marks`), which its legend lists. */
  regions: string[];
  /** Its numbers with no blank cells to sit on (`data-unplaced`), which Screen leaves out. */
  unplaced: string[];
  /** The ordered lists of its legend (`[data-legend]`), and their items, not nested ones. */
  legends: number;
  legendItems: number;
  boot: string[];
  /** A RunHere's starting round trip (`data-latency`), in ms. */
  latency?: string;
  /** Its range inputs, with whether they sit in a `<label>`. */
  ranges: { labelled: boolean; min: number; max: number }[];
  /** The text of its labels outside their `<output>`, and of its outputs. */
  label: string;
  outputs: string[];
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

/** The round trip the embed's `network` command takes (packages/core/src/web/embed.ts). */
const MAX_LATENCY_MS = 10_000;
/** A range input's bounds when it does not set them (HTML). */
const RANGE = { min: 0, max: 100 };

/**
 * What a page's HTML breaks of the kit's contracts, one line each, and how many figures it
 * holds. `page` is the page's address (`/docs/…/`), which says its language too.
 */
export async function kitProblems(html: string, page: string) {
  const figures: Figure[] = [];
  const open: Figure[] = [];
  const ids = new Map<string, number>();
  const demo: string[] = [];
  let labels = 0;
  /** The output being read, by its count in the figure's outputs. */
  let output: number | undefined;
  let text: ((chunk: string) => void) | undefined;
  const inner = () => open.at(-1);
  const count = (what: "lists" | "items" | "marks" | "legends" | "legendItems") => {
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
          regions: (element.getAttribute("data-marks") ?? "").split(" ").filter(Boolean),
          unplaced: (element.getAttribute("data-unplaced") ?? "").split(" ").filter(Boolean),
          legends: 0,
          legendItems: 0,
          boot: [],
          latency: element.getAttribute("data-latency") ?? undefined,
          ranges: [],
          label: "",
          outputs: [],
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
    .on("[data-legend] > ol", { element: () => count("legends") })
    .on("[data-legend] > ol > li", { element: () => count("legendItems") })
    .on("[data-boot]", {
      element(element) {
        inner()?.boot.push(element.getAttribute("data-boot") ?? "");
      },
    })
    // A label's own words apart from its output's: what names a slider, and its value. A
    // text handler sees the text of the element's descendants too.
    .on("label", {
      element(element) {
        labels += 1;
        element.onEndTag(() => {
          labels -= 1;
        });
      },
      text(chunk) {
        const figure = inner();
        if (figure && output === undefined) figure.label += chunk.text;
      },
    })
    .on("output", {
      element(element) {
        output = inner()?.outputs.push("");
        element.onEndTag(() => {
          output = undefined;
        });
      },
      text(chunk) {
        const figure = inner();
        if (figure && output !== undefined) figure.outputs[output - 1] += chunk.text;
      },
    })
    .on('input[type="range"]', {
      element(element) {
        inner()?.ranges.push({
          labelled: labels > 0,
          min: Number(element.getAttribute("min") ?? RANGE.min),
          max: Number(element.getAttribute("max") ?? RANGE.max),
        });
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
      if (figure.regions.length > 0) {
        const numbers = figure.regions.map(Number).sort((a, b) => a - b);
        if (numbers.some((n, i) => n !== i + 1))
          say(figure, `its marks ${figure.regions.join(" ")} are not numbered from 1`);
        if (figure.legends === 0) say(figure, "no legend: an ordered list of its marks");
        else if (figure.legendItems !== figure.regions.length)
          say(figure, `${figure.regions.length} marks for ${figure.legendItems} legend items`);
        for (const n of figure.unplaced)
          say(figure, `mark ${n} has no blank cells beside its region: it would hide the screen`);
      }
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
      roundTrip(figure);
    }
  }
  return { problems, figures: figures.length };

  /**
   * A RunHere's slider: there exactly when the page gives it a `latency`, named by the words
   * of its label (seen, not only heard), its value shown in ms, within what the `network`
   * command takes.
   */
  function roundTrip(figure: Figure) {
    const [range, ...more] = figure.ranges;
    if (figure.latency === undefined) {
      if (range) say(figure, "a round-trip slider, and no latency to start it from");
      return;
    }
    if (!range) return void say(figure, `latency="${figure.latency}", and no round-trip slider`);
    if (more.length > 0) say(figure, `${figure.ranges.length} round-trip sliders`);
    if (!range.labelled || !figure.label.trim()) say(figure, "its round-trip slider has no label");
    if (!figure.outputs.some((output) => /^\d+ ms$/.test(output.trim())))
      say(figure, "its round-trip slider shows no value in ms");
    if (!(range.min >= 0 && range.max <= MAX_LATENCY_MS))
      say(
        figure,
        `its round trip goes from ${range.min} to ${range.max} ms, beyond the network command's 0 to ${MAX_LATENCY_MS}`,
      );
    const latency = Number(figure.latency);
    if (!(latency >= range.min && latency <= range.max))
      say(
        figure,
        `its latency, ${figure.latency} ms, is off its slider's ${range.min} to ${range.max}`,
      );
  }
}
