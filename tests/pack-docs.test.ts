import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { build, convertPage, generate } from "../scripts/pack-docs.ts";
import { order } from "../website/src/lib/docs/sections.ts";

// The documentation shipped inside @luciole-sh/core (scripts/pack-docs.ts): the website's
// MDX as Markdown, read by an agent from node_modules/@luciole-sh/core/docs/.

/** The text of a Markdown file outside its fenced code and its inline code. */
function prose(markdown: string) {
  let fence: string | undefined;
  const kept: string[] = [];
  for (const line of markdown.split("\n")) {
    const mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === undefined) {
      if (mark === undefined) kept.push(line.replace(/`+[^`]*`+/g, ""));
      else fence = mark;
    } else if (mark !== undefined && mark.startsWith(fence) && line.trim() === mark) {
      fence = undefined;
    }
  }
  return kept.join("\n");
}

const title = (name: string) => `---\ntitle: ${name}\ndescription: About ${name}.\n---\n\n`;

/** A directory of MDX pages, by id. */
function pagesOf(pages: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "pack-docs-"));
  for (const [id, body] of Object.entries(pages)) {
    mkdirSync(dirname(join(dir, `${id}.mdx`)), { recursive: true });
    writeFileSync(join(dir, `${id}.mdx`), title(id) + body);
  }
  return dir;
}

/** The message a promise rejects with. */
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => "it did not fail",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

const sections = (...pages: string[]) => [{ title: "All", summary: "Every page.", pages }];
const manifest = join(import.meta.dir, "../packages/core/package.json");

describe("the generated documentation", async () => {
  const files = await build();

  test("holds one page per page of the nav, and a README", () => {
    expect(Object.keys(files).toSorted()).toEqual(
      ["README.md", ...order.map((id) => `${id}.md`)].toSorted(),
    );
  });

  test("ships the upstream library boundaries and routing links", () => {
    expect(files["reference/upstream-libraries.md"]).toContain("## TanStack Router");
    expect(files["concepts/routing.md"]).toContain("../reference/upstream-libraries.md");
  });

  test("keeps no import line and no leftover component", () => {
    for (const [path, text] of Object.entries(files)) {
      const plain = prose(text);
      expect(plain.match(/^(import|export) .*$/m)?.[0], `${path}: an import line`).toBeUndefined();
      expect(plain.match(/<[A-Z]\w*/)?.[0], `${path}: a JSX tag`).toBeUndefined();
    }
  });

  test("links every page to a page that exists, relatively", () => {
    for (const [path, text] of Object.entries(files)) {
      for (const [, target] of prose(text).matchAll(
        /\]\((?![a-z]+:)([^)\s#]+\.md)(?:#[^)\s]*)?\)/g,
      )) {
        const resolved = join(dirname(path), target ?? "");
        expect(Object.hasOwn(files, resolved), `${path} links to ${target}`).toBe(true);
      }
      expect(prose(text), path).not.toContain("](/docs/");
    }
  });

  test("lists every page in the README, in the order of the nav", () => {
    const listed = [...(files["README.md"] ?? "").matchAll(/^- \[[^\]]+\]\(([^)]+)\.md\): .+$/gm)];
    expect(listed.map(([, id]) => id)).toEqual([...order]);
  });

  test("carries the code of the checkout in an excerpt, with its path and lines", () => {
    expect(files["concepts/client-and-server.md"]).toMatch(
      /From `examples\/notes\/[^`]+`, lines? \d+/,
    );
  });
});

describe("a page", () => {
  const known = new Set(["a", "deep/b"]);

  test("links another page relatively, with its anchor, and the site by URL", () => {
    const markdown = convertPage(
      "deep/b",
      `${title("B")}See [a](/docs/a/#top), [self](/docs/deep/b/) and [status](/status/). [Source](https://github.com/o/r/blob/x/f.ts).`,
      known,
    );
    expect(markdown).toContain("[a](../a.md#top), [self](b.md)");
    expect(markdown).toContain("[status](https://luciole.sh/status/)");
    expect(markdown).toContain("[Source](https://github.com/o/r/blob/x/f.ts)");
  });

  test("leaves a link inside fenced code as it is", () => {
    const markdown = convertPage("a", `${title("A")}\`\`\`md\n[a](/docs/a/)\n\`\`\``, known);
    expect(markdown).toContain("```md\n[a](/docs/a/)\n```");
  });

  test("names a component in a description or a figure as code, not as a tag", () => {
    const markdown = convertPage(
      "a",
      "---\ntitle: A\ndescription: Run it with <Terminal>.\n---\n\n" +
        '<Sequence title="S" caption="C." lanes={[{ id: "c", label: "Client", tone: "client" }]} ' +
        'messages={[{ from: "c", to: "c", label: "renders <Editor>" }]} />',
      known,
    );
    expect(markdown).toContain("Run it with `<Terminal>`.");
    expect(markdown).toContain("Client: renders `<Editor>`");
  });

  test("a note is a quote and a command a shell block", () => {
    const markdown = convertPage(
      "a",
      `${title("A")}<Note>\n  Careful.\n</Note>\n\n<CopyCommand lines={["bun install"]} />`,
      known,
    );
    expect(markdown).toContain("> **Note:**\n>\n> Careful.");
    expect(markdown).toContain("```sh\nbun install\n```");
  });
});

describe("a generation that cannot be trusted", () => {
  test("fails on a component it does not know, naming the page and the component", async () => {
    const docs = pagesOf({ a: "<Mystery size={3} />\n" });
    expect(await failure(build({ docs, sections: sections("a"), manifest }))).toContain(
      "<Mystery> in a.mdx has no Markdown form",
    );
  });

  test("fails on a component it does not know inside a sentence too", async () => {
    const docs = pagesOf({ "x/y": "A sentence with <Mystery /> inside.\n" });
    expect(await failure(build({ docs, sections: sections("x/y"), manifest }))).toContain(
      "<Mystery> in x/y.mdx has no Markdown form",
    );
  });

  test("fails on a link to a page that does not exist", async () => {
    const docs = pagesOf({ a: "[gone](/docs/gone/)\n" });
    expect(await failure(build({ docs, sections: sections("a"), manifest }))).toContain(
      "a.mdx links to /docs/gone/, which is no page",
    );
  });

  test("fails on a page that is not in the nav, and a nav entry without a page", async () => {
    const docs = pagesOf({ a: "Text.\n", b: "Text.\n" });
    expect(await failure(build({ docs, sections: sections("a"), manifest }))).toContain(
      "b.mdx is not in the nav",
    );
    expect(await failure(build({ docs, sections: sections("a", "b", "c"), manifest }))).toContain(
      "the nav lists c, which has no page",
    );
  });
});

describe("generate", () => {
  test("writes the pages and the README, and drops what an earlier run left", async () => {
    const docs = pagesOf({ a: "Text.\n", "deep/b": "[a](/docs/a/)\n" });
    const out = join(mkdtempSync(join(tmpdir(), "pack-docs-out-")), "docs");
    mkdirSync(out);
    writeFileSync(join(out, "stale.md"), "old");
    const paths = await generate(out, { docs, sections: sections("a", "deep/b"), manifest });
    expect(paths.toSorted()).toEqual(["README.md", "a.md", "deep/b.md"]);
    expect(existsSync(join(out, "stale.md"))).toBe(false);
    expect(readFileSync(join(out, "deep/b.md"), "utf8")).toContain("[a](../a.md)");
    expect(readFileSync(join(out, "README.md"), "utf8")).toContain("- [a](a.md): About a.");
  });
});
