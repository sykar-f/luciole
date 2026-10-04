import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type Finding,
  lintSource,
  ratchet,
  readAllowlist,
  readAvoidTerms,
  run,
  stylePath,
} from "../website/scripts/prose-lint.ts";

// The prose lint of website/STYLE.md. The public corpus must hold the ratchet of
// website/scripts/prose-allowlist.json; the other tests pin each rule on text quoted from
// the pages, so that a page rewrite does not take a rule's proof with it.
const root = resolve(import.meta.dir, "..");

const rulesOf = (source: string, path = "page.mdx") =>
  lintSource(path, source).map(({ line, rule }) => `${line} ${rule}`);

const findingsOf = (source: string, path = "page.mdx") =>
  lintSource(path, source).map(({ line, rule, detail }) => `${line} ${rule} ${detail}`);

describe("the public corpus", () => {
  const { files, findings, errors } = run();

  test("holds the allowlist's ratchet", () => {
    expect(errors).toEqual([]);
  });

  test("has every README of a package and of an example", () => {
    const readmes = ["packages", "examples"].flatMap((directory) =>
      readdirSync(join(root, directory))
        .map((name) => `${directory}/${name}/README.md`)
        .filter((path) => existsSync(join(root, path))),
    );
    expect(readmes.length).toBeGreaterThan(10);
    for (const readme of readmes) expect(files).toContain(readme);
  });

  test("has the docs, the README, and the site's public pages and the text they show", () => {
    for (const file of [
      "README.md",
      "website/src/content/docs/getting-started.mdx",
      "website/src/pages/index.astro",
      "website/src/pages/status.astro",
      "website/src/pages/examples/index.astro",
      "website/src/pages/docs/index.astro",
      "website/src/components/Hero.astro",
      "website/src/components/Anywhere.astro",
      "website/src/components/ServerSide.astro",
      "website/src/components/Start.astro",
      "website/src/lib/examples.ts",
      "website/src/lib/docs/nav.ts",
    ])
      expect(files).toContain(file);
  });

  test("leaves out the French guide, the lab and the Open Graph picture", () => {
    expect(files.filter((file) => /\/(guide|lab)\/|Guide\.astro|og\.astro/.test(file))).toEqual([]);
  });

  test("fails when a page's count drops and its entry does not", () => {
    // The first listed page, as if a mission had fixed one finding and kept its entry.
    const [path, count] = Object.entries(readAllowlist())[0] ?? ["", 0];
    const found = findings.filter((finding) => finding.path === path).length;
    expect(found).toBe(count);
    expect(run([], { ...readAllowlist(), [path]: count + 1 }).errors).toEqual([
      `${path}: ${count} findings, lower its count from ${count + 1} to ${count}`,
    ]);
  });
});

describe("the ratchet", () => {
  const finding = (path: string): Finding => ({ path, line: 1, rule: "long-sentence", detail: "" });
  const checked = ["a.mdx", "b.mdx"];

  test("passes listed files at their count, and clean files off the list", () => {
    expect(ratchet([finding("a.mdx"), finding("a.mdx")], { "a.mdx": 2 }, checked)).toEqual([]);
  });

  test("refuses a listed file whose count drops: the entry follows it down", () => {
    expect(ratchet([finding("a.mdx")], { "a.mdx": 2 }, checked)).toEqual([
      "a.mdx: 1 findings, lower its count from 2 to 1",
    ]);
  });

  test("refuses a finding in a file that is not on the list", () => {
    expect(ratchet([finding("b.mdx")], { "a.mdx": 1 }, checked)).toContain(
      "b.mdx: 1 findings, and the file is not on the allowlist",
    );
  });

  test("refuses a listed file whose count grows", () => {
    expect(ratchet([finding("a.mdx"), finding("a.mdx")], { "a.mdx": 1 }, checked)).toEqual([
      "a.mdx: 2 findings, the allowlist allows 1",
    ]);
  });

  test("refuses a listed file with no finding left", () => {
    expect(ratchet([], { "a.mdx": 3 }, checked)).toEqual([
      "a.mdx: no finding left, remove it from the allowlist",
    ]);
  });

  test("refuses a listed file the lint does not read", () => {
    expect(ratchet([], { "gone.mdx": 1 }, checked)).toEqual([
      "gone.mdx: not a page the lint reads, remove it from the allowlist",
    ]);
  });
});

describe("split-paragraph", () => {
  // The three cases the reviews found, as the pages had them on 2026-10-04.
  test("reports a sentence cut before <kbd>, as in concepts/client-components", () => {
    const page = [
      "The framework declares only <kbd>Ctrl+C</kbd> (quit) and, during a navigation,",
      "",
      "<kbd>Esc</kbd> (cancel), in the `luciole` group.",
    ].join("\n");
    expect(rulesOf(page)).toEqual(["3 split-paragraph"]);
  });

  test("reports a sentence cut before <kbd>, as in guides/devtools", () => {
    const page = [
      "Common keys: <kbd>1</kbd>–<kbd>7</kbd> or <kbd>Tab</kbd> switch panels, <kbd>j</kbd> /",
      "",
      "<kbd>k</kbd> or the arrows select.",
    ].join("\n");
    expect(rulesOf(page)).toEqual(["3 split-paragraph"]);
  });

  test("reports a sentence cut before <code>, as in reference/cli", () => {
    const page = [
      "The package declares two commands. In a clone of the repository,",
      "",
      "<code>{commands.fromClone}</code> runs the same CLI without installing anything.",
    ].join("\n");
    expect(rulesOf(page)).toEqual(["3 split-paragraph"]);
  });

  test("reports lowercase text that goes on with a cut sentence", () => {
    expect(rulesOf("The Client draws the page with\n\nOpenTUI and the Server.")).toEqual([]);
    expect(rulesOf("The Client draws the page with\n\nthe help of OpenTUI.")).toEqual([
      "3 split-paragraph",
    ]);
  });

  test("lets a paragraph start lowercase or with a tag after a full sentence", () => {
    expect(rulesOf("The Server renders.\n\nluciole draws it.")).toEqual([]);
    expect(rulesOf("Keys of the list:\n\n<kbd>Enter</kbd> opens a note.")).toEqual([]);
    expect(rulesOf("## Keys\n\n<kbd>Enter</kbd> opens a note.")).toEqual([]);
  });
});

describe("lengths and clauses", () => {
  // A sentence starts with a capital: lowercase text after a full stop goes on with it.
  const sentence = (count: number) =>
    `Word${Array.from({ length: count - 1 }, () => " word").join("")}.`;

  test("a sentence over 30 words, a paragraph over 60", () => {
    expect(rulesOf(sentence(30))).toEqual([]);
    expect(rulesOf(sentence(31))).toEqual(["1 long-sentence"]);
    expect(rulesOf(`${sentence(30)} ${sentence(30)}`)).toEqual([]);
    expect(rulesOf(`${sentence(30)}\n${sentence(25)} ${sentence(6)}`)).toEqual([
      "1 long-paragraph",
    ]);
  });

  test("reports the line where the sentence starts", () => {
    expect(rulesOf(`Short one.\nThen ${sentence(31)}`)).toEqual(["2 long-sentence"]);
  });

  test("a code span, an expression and a link count as one word each", () => {
    const code = "`a b c d e f g h i j`";
    const words = `${code} [one two](https://luciole.sh/docs/x/) {a + b}`;
    expect(rulesOf(`${sentence(26).slice(0, -1)} ${words}.`)).toEqual([]);
    expect(rulesOf(`${sentence(27).slice(0, -1)} ${words}.`)).toEqual(["1 long-sentence"]);
  });

  test("two semicolons, or a semicolon and a colon, in one sentence", () => {
    // getting-started.mdx:54-56, before and after its rewrite.
    expect(
      rulesOf(
        "The route and named fields come back; state held only in memory does not: there is no Fast Refresh.",
      ),
    ).toEqual(["1 chained-clauses"]);
    expect(rulesOf("One; two; three.")).toEqual(["1 chained-clauses"]);
    expect(
      rulesOf(
        "The route and named fields come back. State held only in memory is lost: there is no Fast Refresh.",
      ),
    ).toEqual([]);
    expect(rulesOf("One clause; another.")).toEqual([]);
  });

  test("punctuation inside code, URLs and links does not count", () => {
    expect(rulesOf("Run `a; b; c: d` from https://luciole.sh/docs; then stop.")).toEqual([]);
  });

  test("a sentence may start with code, an expression or a component", () => {
    for (const start of ["`--app`", "{commands.cli}", '<Src path="a.ts" />'])
      expect(rulesOf(`${sentence(20)} ${start} ${sentence(20).toLowerCase()}`)).toEqual([]);
  });

  test("abbreviations do not end a sentence", () => {
    expect(rulesOf(`Some flags, e.g. ${sentence(27)}`)).toEqual([]);
    expect(rulesOf(`Some flags, e.g. ${sentence(28)}`)).toEqual(["1 long-sentence"]);
  });
});

describe("what is not prose", () => {
  test("front matter but its description, imports, fences, headings and tags are skipped", () => {
    const long = Array.from({ length: 40 }, () => "word").join(" ");
    const page = [
      "---",
      `title: ${long}; one: two; three.`,
      "---",
      "",
      'import Note from "../Note.astro";',
      "import {",
      "  a,",
      '} from "x";',
      "",
      `## ${long}`,
      "",
      "```ts",
      `// ${long}; a; b: c`,
      "```",
      "",
      "<Excerpt",
      `  path="${long}"`,
      "/>",
      "",
      '<p align="center">',
      `  <img alt="${long}" />`,
      "</p>",
    ].join("\n");
    expect(rulesOf(page)).toEqual([]);
  });

  test("the description of the front matter is prose", () => {
    const page = ["---", "title: A page", "description: 'One; two; it''s three.'", "---"].join(
      "\n",
    );
    expect(rulesOf(page)).toEqual(["3 chained-clauses"]);
  });

  test("each table cell is a paragraph, with the same limits", () => {
    const long = `${Array.from({ length: 31 }, () => "word").join(" ")}.`;
    const page = [
      "| Column | Other |",
      "| :----- | ----- |",
      `| ${long} | short |`,
      "| `a | b; c; d` | One; two; three. |",
      "| lowercase start | goes on |",
    ].join("\n");
    expect(rulesOf(page)).toEqual(["3 long-sentence", "4 chained-clauses"]);
  });

  test("the text inside a Note is prose", () => {
    const page = ['<Note kind="warning">', "  One; two; three.", "</Note>"].join("\n");
    expect(rulesOf(page)).toEqual(["2 chained-clauses"]);
  });

  test("each list item is a paragraph of its own", () => {
    const item = Array.from({ length: 40 }, () => "word").join(" ");
    const page = [`- ${item}.`, `- ${item}.`].join("\n");
    expect(rulesOf(page)).toEqual(["1 long-sentence", "2 long-sentence"]);
  });
});

describe("avoid-term", () => {
  const terms = (source: string, path?: string) =>
    findingsOf(source, path)
      .filter((finding) => finding.includes("avoid-term"))
      .map((finding) => finding.replace(/:.*$/, ""));

  test("flags the forms of the table in prose, not in code", () => {
    // The landing's sub-title (Hero.astro:64) and its rewrite.
    expect(
      terms("Server Components render next to your data, the client runs in your terminal."),
    ).toEqual(['1 avoid-term "client"']);
    expect(
      terms("Server Components render next to your data, the Client runs in your terminal."),
    ).toEqual([]);
    expect(terms("Import it from `client`, or `@luciole-sh/core/client`.")).toEqual([]);
    expect(terms("<code>the client</code> and {client} are not prose.")).toEqual([]);
  });

  test("keeps the generic sense and the code names", () => {
    expect(terms("An HTTP client, an SSH server and a web server are not luciole's.")).toEqual([]);
    expect(terms("`saveAction` posts to /action, and actions/ holds it.")).toEqual([]);
    expect(terms('GitHub Actions runs it. A `"use server"` module or "use client".')).toEqual([]);
    expect(terms("Pages, actions and repositories read it.")).toEqual(['1 avoid-term "actions"']);
  });

  test("tells the two sessions apart from the one the table refuses", () => {
    expect(terms("The sign-in session, the restored session, the Session restore page.")).toEqual(
      [],
    );
    expect(terms("A request without it has no session.")).toEqual(['1 avoid-term "session"']);
    expect(terms("Replacing a bearer forgets the text; the bearer token stays.")).toEqual([
      '1 avoid-term "bearer"',
    ]);
  });

  test("lets Notes name its Draft, and no framework page", () => {
    const line = "Anything held only in memory, Drafts included, is lost.";
    expect(terms(line, "examples/notes/README.md")).toEqual([]);
    expect(terms(line, "website/src/content/docs/concepts/session-restore.mdx")).toEqual([
      '1 avoid-term "Drafts"',
    ]);
  });

  test("checks headings and table cells, and reports the line of the form", () => {
    expect(terms("## The connection, in the app's chrome")).toEqual(['1 avoid-term "chrome"']);
    expect(terms("| Transport | build ID, bearer |\n| - | - |\n| Luciole | x |")).toEqual([
      '1 avoid-term "bearer"',
      '3 avoid-term "Luciole"',
    ]);
    expect(terms("One line.\nThen the dev server")).toEqual(['2 avoid-term "server"']);
  });

  test("an allow comment silences one", () => {
    expect(
      terms(
        "{/* prose-lint: allow avoid-term — a process session, not luciole's */}\nIts own session.",
      ),
    ).toEqual([]);
  });

  test("reads every row of the STYLE.md table, and refuses a row without a line", () => {
    const style = readFileSync(stylePath, "utf8");
    expect(readAvoidTerms(style).length).toBeGreaterThan(10);
    const withoutChrome = style.replace(/^\/\\bchrome.*\n/m, "");
    expect(() => readAvoidTerms(withoutChrome)).toThrow(
      `no avoid-term line for "The persistent part of an app's screen"`,
    );
    const unknown = style.replace("/\\bchrome\\b/ The persistent", "/\\bchrome\\b/ The chrome");
    expect(() => readAvoidTerms(unknown)).toThrow(
      `names "The chrome part of an app's screen", not a row of the table`,
    );
  });
});

describe("Astro pages and TypeScript modules", () => {
  const astro = (source: string) => rulesOf(source, "page.astro");
  const long = Array.from({ length: 31 }, () => "word").join(" ");

  test("the markup's text is prose, one paragraph per block element", () => {
    const page = [
      "<section>",
      "  <p>",
      `    ${long.slice(0, 50)}`,
      `    ${long.slice(50)}.`,
      "  </p>",
      "  <p>One; two; three.</p>",
      "</section>",
    ].join("\n");
    expect(astro(page)).toEqual(["3 long-sentence", "6 chained-clauses"]);
  });

  test("inline elements, code and expressions sit in the sentence as words", () => {
    const words = (count: number) => Array.from({ length: count }, () => "word").join(" ");
    const sentence = (count: number) =>
      `<p>Run <code>a b c; d: e</code> <strong>now</strong> with {commands.cli}${'{" "}'}${words(count)}.</p>`;
    expect(astro(sentence(25))).toEqual([]);
    expect(astro(sentence(26))).toEqual(["1 long-sentence"]);
  });

  test("the front matter's prose literals and the attributes a reader sees are prose", () => {
    const page = [
      "---",
      'import Page from "../layouts/Page.astro";',
      'const steps = ["bun run dev", "cd my-app", "both sides on your machine; one; two"];',
      "---",
      '<Page title="Project status" description="One; two; three." class="a b">',
      '  <img src="/a.png" alt="the client draws it" />',
      "</Page>",
    ].join("\n");
    expect(findingsOf(page, "page.astro")).toEqual([
      "3 chained-clauses 2 semicolons, 0 colons",
      "5 chained-clauses 2 semicolons, 0 colons",
      '6 avoid-term "client": luciole\'s two programs',
    ]);
  });

  test("the elements an expression holds are read, its code is not", () => {
    const page = [
      "<ul>",
      "  {items.map((item) => (",
      '    <li data-x={item.id > 2 ? "a" : "b"}>',
      "      {item.name} keeps the session",
      "    </li>",
      "  ))}",
      "</ul>",
    ].join("\n");
    expect(findingsOf(page, "page.astro")).toEqual([
      '4 avoid-term "session": What `authenticate` returns, What the Client keeps across restarts',
    ]);
  });

  test("headings are checked for terms only; scripts and styles are not prose", () => {
    const page = [
      `<h2>${long}; the chrome</h2>`,
      "<script>",
      `  const a = "${long}; the client";`,
      "</script>",
      "<style>",
      "  p { color: red; }",
      "</style>",
    ].join("\n");
    expect(astro(page)).toEqual(["1 avoid-term"]);
  });

  test("an allow comment in the markup or the code silences one finding", () => {
    expect(
      astro("<!-- prose-lint: allow chained-clauses — a list -->\n<p>One; two; three.</p>"),
    ).toEqual([]);
    expect(
      rulesOf(
        '// prose-lint: allow chained-clauses — a list\nconst a = "one; two; three";',
        "a.ts",
      ),
    ).toEqual([]);
  });

  test("a module gives its prose literals, not its keys, paths or commands", () => {
    const module = [
      "export const examples = {",
      '  forge: { run: "bun run forge", source: "examples/forge", frame: "forge-files",',
      "    about:",
      '      "Answers stream from a Server Function; the key never leaves the server.",',
      "  },",
      "};",
      'const pattern = /"[a-z]+"/g;',
      "const text = `Notes, ${name}: the client`;",
    ].join("\n");
    expect(findingsOf(module, "a.ts")).toEqual([
      '4 avoid-term "server": luciole\'s two programs',
      '8 avoid-term "client": luciole\'s two programs',
    ]);
  });

  test("a source the scanner cannot read fails with its path and line", () => {
    expect(() => lintSource("page.astro", "<section>\n  <p>text\n</section>")).toThrow(
      "page.astro: line 3: </section> closes <p>",
    );
  });
});

describe("exceptions", () => {
  const long = `${Array.from({ length: 31 }, () => "word").join(" ")}.`;

  test("an allow comment on the line before silences one finding", () => {
    const page = `{/* prose-lint: allow long-sentence — a list of flags reads as one unit */}\n${long}`;
    expect(rulesOf(page)).toEqual([]);
    expect(rulesOf(`<!-- prose-lint: allow long-sentence — a table row -->\n${long}`)).toEqual([]);
  });

  test("an allow comment without a reason, or for an unknown rule, is a finding", () => {
    expect(rulesOf(`{/* prose-lint: allow long-sentence */}\n${long}`)).toEqual([
      "1 bad-allow",
      "2 long-sentence",
    ]);
    expect(rulesOf(`{/* prose-lint: allow wordy — because */}\nShort.`)).toEqual(["1 bad-allow"]);
  });

  test("an allow comment that silences nothing is a finding", () => {
    expect(rulesOf("{/* prose-lint: allow long-sentence — no longer */}\nShort.")).toEqual([
      "1 unused-allow",
    ]);
  });
});

test("the command prints path:line rule and fails off the allowlist", async () => {
  const directory = mkdtempSync(join(tmpdir(), "prose-lint-"));
  const page = join(directory, "page.mdx");
  writeFileSync(page, "One; two; three.\n");
  const child = Bun.spawn([process.execPath, "website/scripts/prose-lint.ts", page], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(out).toMatch(/^\S*page\.mdx:1 chained-clauses \(2 semicolons, 0 colons\)\n$/);
  expect(code).toBe(1);
});
