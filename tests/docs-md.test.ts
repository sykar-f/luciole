import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { attributes, documentation, literal, toMarkdown } from "../website/scripts/docs-md.ts";

// The Markdown export of the docs (website/scripts/docs-md.ts), which mdreader's demo reads:
// what a figure says survives in Markdown, and a component it cannot render stops it.
const root = join(import.meta.dir, "..");
const docs = join(root, "website/src/content/docs");

const page = (body: string) => `---\ntitle: A page\ndescription: What it gives.\n---\n\n${body}\n`;

/** Every `caption="…"` the pages give a component. */
const captions = readdirSync(docs, { recursive: true, encoding: "utf8" })
  .filter((name) => name.endsWith(".mdx"))
  .flatMap((name) =>
    [...readFileSync(join(docs, name), "utf8").matchAll(/\bcaption="([^"]+)"/g)].map(
      ([, caption]) => caption ?? "",
    ),
  );

describe("the export of the docs", async () => {
  const pages = await documentation();
  const all = pages.map(({ text }) => text).join("\n");

  test("keeps every caption the pages give, the seven of the excerpts among them", () => {
    expect(captions.length).toBeGreaterThanOrEqual(7);
    for (const caption of captions) expect(all).toContain(`*${caption}*`);
    expect(all).toContain(
      "*Type, check that the session file is written with mode 0600, then crash with SIGKILL.*",
    );
  });

  test("keeps the Flight capture whole, and its notes", () => {
    const flight = readFileSync(join(root, "website/src/frames/flight.txt"), "utf8").trimEnd();
    const text = pages.find(({ path }) => path === "concepts/client-and-server.md")?.text ?? "";
    expect(text).toContain(`\`\`\`\`text\n${flight}\n\`\`\`\``);
    expect(text).toContain('2. `0:{"tree":"$1","tags":"$@2"}` is the envelope');
  });
});

describe("a figure in Markdown", () => {
  test("an excerpt: its file, lines and side, its code fenced, its caption", () => {
    const markdown = toMarkdown(
      page(`<Excerpt
  path="examples/notes/app/notes/[id]/page.tsx"
  find="export default async function Page"
  until="^}"
  tone="server"
  caption="The page hands the editor its note."
/>`),
    );
    expect(markdown).toContain(
      "From `examples/notes/app/notes/[id]/page.tsx`, lines 16–28, Server side:\n\n```tsx\nexport default async function Page(",
    );
    expect(markdown).toContain("```\n\n*The page hands the editor its note.*");
  });

  test("a screen: its transcript as a text block, its caption", () => {
    const markdown = toMarkdown(
      page(`<Screen frame="notes" caption="Notes with note 1 open." wide />`),
    );
    expect(markdown).toContain(
      "The screen “Notes: the first note open”, as text:\n\n```text\n ╭───╮",
    );
    expect(markdown).toContain("*Notes with note 1 open.*");
  });

  test("a marked screen: its transcript, its caption, then its legend's numbers", () => {
    const markdown = toMarkdown(
      page(
        [
          `<Screen frame="devtools-network" caption="Both processes' requests." wide marks>`,
          "",
          "  1. `client notes 4101`: the Client process.",
          "  2. The Server process.",
          "     A second line.",
          "",
          "</Screen>",
          "",
          "After the figure.",
        ].join("\n"),
      ),
    );
    expect(markdown).toContain("The screen “DevTools: requests of both processes”, as text:");
    expect(markdown).toContain(
      [
        "*Both processes' requests.*",
        "",
        "1. `client notes 4101`: the Client process.",
        "2. The Server process.",
        "   A second line.",
        "",
        "After the figure.",
      ].join("\n"),
    );
    expect(markdown).not.toContain("Screen>");
  });

  test("a marked screen without its legend, or never closed, stops the export", () => {
    expect(() =>
      toMarkdown(page(`<Screen frame="devtools-network" caption="Requests." marks>\n</Screen>`)),
    ).toThrow('a marked <Screen frame="devtools-network"> has no legend');
    expect(() =>
      toMarkdown(page(`<Screen frame="notes" caption="Notes." marks>`), "a.mdx"),
    ).toThrow("a <Screen> in a.mdx never closes");
  });

  test("a legend whose last line, or whose Screen's line, holds the closing tag", () => {
    const closing = toMarkdown(
      page(
        `<Screen frame="notes" caption="Notes." marks>\n\n1. The list.\n2. The note.</Screen>\n\nAfter.`,
      ),
    );
    expect(closing).toContain("*Notes.*\n\n1. The list.\n2. The note.\n\nAfter.");
    const one = toMarkdown(
      page(`<Screen frame="notes" caption="Notes." marks>1. The list.</Screen>`),
    );
    expect(one).toContain("*Notes.*\n\n1. The list.\n");
    expect(() =>
      toMarkdown(page(`<Screen frame="notes" caption="Notes." marks>1. A.</Screen> more`), "a.mdx"),
    ).toThrow("text after </Screen> on its line in a.mdx: more");
  });

  test("a sequence: its steps, numbered under their phases, and its caption", () => {
    const markdown = toMarkdown(
      page(`<Sequence
  title="A click"
  lanes={[{ id: "c", label: "Client", tone: "client" }, { id: "s", label: "Server", tone: "server" }]}
  messages={[{ phase: "Open" }, { from: "c", to: "s", label: "GET /render", n: 1 }, { from: "s", to: "s", label: "render" }]}
  caption="One round trip."
/>`),
    );
    expect(markdown).toContain(
      "A click, step by step:\n\n**Open**\n\n1. Client → Server: GET /render\n2. Server: render\n\n*One round trip.*",
    );
  });

  test("an annotated capture: the capture fenced, its caption, its notes in order", () => {
    const markdown = toMarkdown(
      page(`<AnnotatedCapture
  path="website/src/frames/flight.txt"
  caption="The answer."
  notes={[{ match: "1:R", note: "opens row 1." }, { match: '2:["note:local:1"]', note: "are the **tags**." }]}
/>`),
    );
    expect(markdown).toContain("````text\n1:R\n");
    expect(markdown).toContain(
      '*The answer.*\n\n1. `1:R` opens row 1.\n2. `2:["note:local:1"]` are the **tags**.',
    );
  });

  test("an annotated capture whose match the capture lost stops the export", () => {
    expect(() =>
      toMarkdown(
        page(
          `<AnnotatedCapture path="website/src/frames/flight.txt" caption="x" notes={[{ match: "$L9", note: "gone" }]} />`,
        ),
      ),
    ).toThrow('"$L9" is not in website/src/frames/flight.txt');
  });

  test("code and its screen, and a demo to run: the code, the transcript, one caption", () => {
    const pair = toMarkdown(
      page(
        `<CodeAndScreen path="examples/notes/app/notes/[id]/page.tsx" find="<NoteEditor" until="/>" frame="notes" caption="The editor and its screen." />`,
      ),
    );
    expect(pair).toContain("```tsx\n<NoteEditor");
    expect(pair).toContain("```text\n ╭───╮");
    expect(pair.match(/\*The editor and its screen\.\*/g)).toHaveLength(1);
    const run = toMarkdown(
      page(`<RunHere demo="notes" frame="notes" name="Notes" caption="Notes, live." />`),
    );
    expect(run).toContain("```text\n ╭───╮");
    expect(run).toContain("*Notes, live.*");
  });

  test("a figure inside a Note stays inside its quote", () => {
    const markdown = toMarkdown(
      page(`<Note>\n  Read this.\n\n<Screen frame="notes" caption="Inside." />\n</Note>`),
    );
    expect(markdown).toContain("> *Inside.*");
    expect(markdown).toContain("> ```text");
  });

  test("a titled Note leads its quote with the title, and keeps its kind", () => {
    const titled = toMarkdown(
      page(`<Note title="Where this number comes from">\n  Read this.\n</Note>`),
    );
    expect(titled).toContain("> **Where this number comes from**\n>\n> Read this.");
    const warning = toMarkdown(
      page(`<Note title="Careful" kind="warning">\n  Read this.\n</Note>`),
    );
    expect(warning).toContain("> **Warning:** **Careful**\n>\n> Read this.");
    const reversed = toMarkdown(
      page(`<Note kind='warning' title='Careful'>\n  Read this.\n</Note>`),
    );
    expect(reversed).toContain("> **Warning:** **Careful**");
  });

  test("a source reference in a sentence links the file, or the line its anchor finds", () => {
    const markdown = toMarkdown(
      page(
        'See <Src path="packages/core/src/build.ts" /> and <Src path="packages/core/src/build.ts" find="export" />.',
      ),
    );
    expect(markdown).toMatch(
      /See \[`src\/build\.ts`\]\(https:\/\/github\.com\/[^)]+\/src\/build\.ts\) and \[`src\/build\.ts:\d+`\]\([^)]+#L\d+\)\./,
    );
  });

  test("a component the export has no Markdown for stops it, named", () => {
    expect(() => toMarkdown(page(`A sentence with <Mystery /> in it.`), "x.mdx")).toThrow(
      "<Mystery> in x.mdx has no Markdown form",
    );
    expect(() => toMarkdown(page(`<Mystery size={3} />`), "concepts/x.mdx")).toThrow(
      "<Mystery> in concepts/x.mdx has no Markdown form",
    );
    expect(() => toMarkdown(page(`<Code code={flight} lang="text" />`))).toThrow(
      "a value that is not a literal",
    );
  });
});

describe("props read from the page", () => {
  test("strings in either quote, literals, and a bare prop", () => {
    expect(
      attributes(`<X a="1" b='"two"' c={[{ k: "v", "q": 'w' }, 2, true, null]} wide />`),
    ).toEqual({
      a: "1",
      b: '"two"',
      c: [{ k: "v", q: "w" }, 2, true, null],
      wide: true,
    });
  });

  test("a template literal reads the names the pages define, and nothing else", () => {
    expect(literal("`${commands.cli} dev`")).toMatch(/ dev$/);
    expect(() => literal("`${secret}`")).toThrow("an unknown ${secret}");
    expect(() => literal("[night]")).toThrow("a value that is not a literal");
  });
});
