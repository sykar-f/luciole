import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { alphabetical, anchorOf, glossary } from "../website/src/lib/docs/glossary.ts";
import { documentation } from "../website/scripts/docs-md.ts";

// The glossary of the docs (website/src/lib/docs/glossary.ts): its terms, and the page that
// lists them.
const root = join(import.meta.dir, "..");
const docs = join(root, "website/src/content/docs");

/** Each docs page's source, by its id. */
const sources = new Map(
  readdirSync(docs, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".mdx"))
    .map((name) => [name.replace(/\.mdx$/, ""), readFileSync(join(docs, name), "utf8")]),
);
/** A heading's anchor, as github-slugger makes it from the heading's text. */
const slug = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
const unticked = (heading: string) => heading.replaceAll("`", "");

describe("the glossary's terms", () => {
  test("each have a name, an anchor and forms of their own", () => {
    const anchors = glossary.map(anchorOf);
    expect(new Set(anchors).size).toBe(glossary.length);
    const forms = glossary.flatMap((entry) => entry.forms.map((form) => form.toLowerCase()));
    expect(new Set(forms).size).toBe(forms.length);
    expect(glossary.length).toBeGreaterThanOrEqual(20);
  });

  test("each have a definition of one or two sentences", () => {
    for (const { name, definition } of glossary) {
      const sentences = definition.split(/(?<=[.?!])\s+(?=[A-Z`"])/);
      expect({ name, sentences: sentences.length <= 2 }).toEqual({ name, sentences: true });
    }
  });

  test("each link to a page that exists, and to a heading of it by the heading's text", () => {
    for (const entry of glossary) {
      const [id = "", anchor] = entry.page.split("#");
      const source = sources.get(id);
      expect({ term: entry.name, page: source !== undefined }).toEqual({
        term: entry.name,
        page: true,
      });
      if (anchor === undefined) {
        const title = /^title: (.+)$/m.exec(source ?? "")?.[1] ?? "";
        expect(entry.see.toLowerCase()).toBe(title.toLowerCase());
        continue;
      }
      const headings = [...(source ?? "").matchAll(/^#{2,3} (.+)$/gm)].map(([, h = ""]) => h);
      const heading = headings.find((candidate) => slug(candidate) === anchor);
      expect({ term: entry.name, heading: heading && unticked(heading) }).toEqual({
        term: entry.name,
        heading: entry.see,
      });
    }
  });

  test("each phrase of another sense still occurs on a page", () => {
    const pages = [...sources.values()].join("\n").replace(/\s+/g, " ").toLowerCase();
    for (const entry of glossary)
      for (const phrase of entry.not ?? [])
        expect({ term: entry.name, phrase, found: pages.includes(phrase.toLowerCase()) }).toEqual({
          term: entry.name,
          phrase,
          found: true,
        });
  });
});

describe("the glossary in the Markdown export", async () => {
  const pages = await documentation();

  test("lists every term, in alphabetical order", () => {
    const page = pages.find(({ path }) => path === "reference/glossary.md")?.text ?? "";
    const names = [...page.matchAll(/^- \*\*(.+?)\*\*: /gm)].map(([, name]) => name);
    expect(names).toEqual(alphabetical.map(({ name }) => name));
  });

});
