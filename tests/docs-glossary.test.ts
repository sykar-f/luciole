import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  alphabetical,
  anchorOf,
  glossary,
  glossaryHref,
  linkTerms,
  type LinkContext,
  type Linked,
} from "../website/src/lib/docs/glossary.ts";
import { documentation } from "../website/scripts/docs-md.ts";

// The glossary of the docs (website/src/lib/docs/glossary.ts): its terms, the page that lists
// them, and the hast plugin that links each term's first occurrence on a page. The plugin
// runs here on trees written by hand, through the two calls it makes of satteri (`parent`,
// `replaceNode`), so the test needs no install of website/.
const root = join(import.meta.dir, "..");
const docs = join(root, "website/src/content/docs");

/** A node that holds others: the root, an element, a component. */
interface Parent {
  type: "root" | "element" | "mdxJsxFlowElement";
  tagName?: string;
  name?: string;
  children: Node[];
}
type Node = Parent | { type: "text"; value: string } | Linked;

const text = (value: string): Node => ({ type: "text", value });
const el = (tagName: string, ...children: (Node | string)[]): Node => ({
  type: "element",
  tagName,
  children: children.map((child) => (typeof child === "string" ? text(child) : child)),
});
const component = (name: string, ...children: Node[]): Node => ({
  type: "mdxJsxFlowElement",
  name,
  children,
});

/**
 * Runs the plugin on a page's tree as satteri does: every text node in document order, each
 * replacement applied once the pass is over. Returns the tree as HTML, or undefined when the
 * plugin leaves the page out.
 */
function linked(page: string, ...children: Node[]) {
  const plugin = linkTerms({ fileURL: pathToFileURL(join(docs, page)) });
  if (!plugin) return undefined;
  const tree: Parent = { type: "root", children };
  const parents = new Map<{ type: string }, Parent>();
  const texts: { type: "text"; value: string }[] = [];
  const walk = (node: Parent) => {
    for (const child of node.children) {
      parents.set(child, node);
      if (child.type === "text") texts.push(child);
      else if (child.type !== "element" || !("properties" in child)) walk(child);
    }
  };
  walk(tree);
  const replacements: [{ type: string }, Linked[]][] = [];
  const ctx: LinkContext = {
    parent: (node) => parents.get(node),
    replaceNode: (node, parts) => replacements.push([node, parts]),
  };
  for (const node of texts) plugin.text(node, ctx);
  for (const [node, parts] of replacements) {
    const parent = parents.get(node);
    const at = parent?.children.findIndex((child) => child === node) ?? -1;
    if (parent && at >= 0) parent.children.splice(at, 1, ...parts);
  }
  return html(tree);
}

function html(node: Node): string {
  if (node.type === "text") return node.value;
  const inner = node.children.map((child: Node) => html(child)).join("");
  if (node.type === "root") return inner;
  if (node.type === "mdxJsxFlowElement") return `<${node.name}>${inner}</${node.name}>`;
  const href = "properties" in node ? ` href="${node.properties.href}"` : "";
  return `<${node.tagName}${href}>${inner}</${node.tagName}>`;
}

const term = (name: string) => {
  const found = glossary.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no term ${name}`);
  return found;
};
const link = (name: string, as = name) => `<a href="${glossaryHref(term(name))}">${as}</a>`;
const page = "concepts/routing.mdx";

describe("the glossary links of a docs page", () => {
  test("link the first occurrence of a term, and not the later ones", () => {
    expect(linked(page, el("p", "The Server renders. The Server answers."))).toBe(
      `<p>The ${link("Server")} renders. The Server answers.</p>`,
    );
    expect(linked(page, el("p", "A token."), el("p", "The token."))).toBe(
      `<p>A ${link("token")}.</p><p>The token.</p>`,
    );
  });

  test("skip code, headings, links, figures and components, which do not count either", () => {
    const tree = [
      el("h2", "Where the Server runs"),
      el("p", el("code", "Server"), " and ", el("a", "Server")),
      el("pre", el("code", "the Server")),
      el("figure", el("figcaption", "The Server.")),
      component("Excerpt", el("p", "The Server.")),
      el("p", "Then the Server."),
    ];
    expect(linked(page, ...tree)).toBe(
      "<h2>Where the Server runs</h2><p><code>Server</code> and <a>Server</a></p>" +
        "<pre><code>the Server</code></pre><figure><figcaption>The Server.</figcaption></figure>" +
        `<Excerpt><p>The Server.</p></Excerpt><p>Then the ${link("Server")}.</p>`,
    );
  });

  test("read a Note's text as prose", () => {
    expect(linked(page, component("Note", el("p", "Flight carries it.")))).toBe(
      `<Note><p>${link("Flight")} carries it.</p></Note>`,
    );
  });

  test("link several terms of one text, the longest form first", () => {
    expect(linked(page, el("p", "Server Components, then the Server and its routes."))).toBe(
      `<p>${link("Server Component", "Server Components")}, then the ${link("Server")} and its ${link("route", "routes")}.</p>`,
    );
  });

  test("match a lowercase form with a capital, over a line break, as a whole word", () => {
    expect(linked(page, el("p", "Layouts hold a sign-in\nsession."))).toBe(
      `<p>${link("layout", "Layouts")} hold a ${link("sign-in session", "sign-in\nsession")}.</p>`,
    );
    expect(linked(page, el("p", "Serverless, server-only, Server-side, @x/Server."))).toBe(
      "<p>Serverless, server-only, Server-side, @x/Server.</p>",
    );
  });

  test("leave a form plain in a phrase where it means something else", () => {
    expect(linked(page, el("p", "Host unreachable. Then the host checks."))).toBe(
      `<p>Host unreachable. Then the ${link("host")} checks.</p>`,
    );
  });

  test("leave the glossary page and the pages outside the docs alone", () => {
    expect(linked("reference/glossary.mdx", el("p", "The Server."))).toBeUndefined();
    expect(linkTerms({ fileURL: pathToFileURL(join(root, "README.md")) })).toBe(false);
    expect(linkTerms({ fileURL: undefined })).toBe(false);
  });
});

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

  test("links no term on the other pages, as their source does not", () => {
    for (const { path, text: markdown } of pages)
      expect({ path, linked: markdown.includes("/docs/reference/glossary/#") }).toEqual({
        path,
        linked: false,
      });
  });
});
