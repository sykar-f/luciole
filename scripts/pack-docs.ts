/**
 * The documentation of the website (website/src/content/docs, MDX) as plain Markdown in
 * packages/core/docs/, so that an app that installs @luciole-sh/core reads, offline, the
 * pages of the version it installed:
 *
 *   bun scripts/pack-docs.ts [directory]     # from the repository root; default: packages/core/docs
 *
 * `prepack` of packages/core runs it, and `files` ships its output; the directory is
 * generated, never committed (.gitignore). The conversion of each page is the website's
 * own export (website/scripts/docs-md.ts: notes, commands, excerpts of the checkout,
 * screens as text). This script adds what a package needs on top of it:
 *   - one file per page of the nav (website/src/lib/docs/sections.ts), at the page's own
 *     relative path, and README.md: one line per page in nav order, the agent's map;
 *   - links between pages as relative `.md` links, links to the site as absolute URLs
 *     (links to the source tree are URLs already);
 *   - a page that is not in the nav, or a nav entry without a page, fails the generation, as
 *     does a link to a page that does not exist, or a component the export has no Markdown
 *     for, each naming the page.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { z } from "zod";
import { toMarkdown } from "../website/scripts/docs-md.ts";
import { sections as navSections, type Section } from "../website/src/lib/docs/sections.ts";

const root = resolve(import.meta.dirname, "..");
const SITE = "https://luciole.sh";
const Manifest = z.looseObject({ version: z.string() });

export interface Options {
  /** The MDX pages. */
  docs?: string;
  /** The order of the pages, in sections. */
  sections?: readonly Section[];
  /** The package the README names. */
  manifest?: string;
}

/** Applies `change` to the lines of a Markdown text that are not fenced code. */
function prose(markdown: string, change: (line: string) => string) {
  let fence: string | undefined;
  return markdown
    .split("\n")
    .map((line) => {
      const mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence === undefined) {
        if (mark === undefined) return change(line);
        fence = mark;
      } else if (mark !== undefined && mark.startsWith(fence) && line.trim() === mark) {
        fence = undefined;
      }
      return line;
    })
    .join("\n");
}

/** Applies `change` to the parts of a line outside its inline code spans. */
function outsideCode(line: string, change: (text: string) => string) {
  return line
    .split(/(`+[^`]*`+)/)
    .map((part, i) => (i % 2 === 1 ? part : change(part)))
    .join("");
}

/**
 * One page in Markdown, from its MDX. `known` is the ids of the pages; a link between pages
 * becomes a relative link to the other page's `.md`.
 */
export function convertPage(id: string, mdx: string, known: ReadonlySet<string>) {
  const markdown = toMarkdown(mdx, `${id}.mdx`);
  return prose(markdown, (line) =>
    outsideCode(line, (text) =>
      text
        .replace(
          /\]\(\/docs\/([^)\s#]*?)\/?(#[^)\s]*)?\)/g,
          (_, target: string, hash: string | undefined) => {
            if (target === "")
              return `](${posix.relative(posix.dirname(id), "README")}.md${hash ?? ""})`;
            if (!known.has(target)) {
              throw new Error(`pack-docs: ${id}.mdx links to /docs/${target}/, which is no page.`);
            }
            return `](${posix.relative(posix.dirname(id), target)}.md${hash ?? ""})`;
          },
        )
        .replace(/\]\((\/[^)\s]*)\)/g, (_, path: string) => `](${SITE}${path})`)
        // A component named in a sentence, not a component of the page: `<Terminal>` as text.
        .replace(/<([A-Z]\w*)>/g, "`<$1>`"),
    ),
  );
}

/** The README: every page of the nav in its order, each with its title and description. */
export function readme(
  version: string,
  sections: readonly Section[],
  pages: ReadonlyMap<string, string>,
) {
  const out = [
    "# luciole documentation",
    "",
    `The documentation of \`@luciole-sh/core\` ${version}, the version installed here: read it before` +
      " the website, which follows the latest release. One page per line, in reading order.",
    "",
  ];
  for (const section of sections) {
    out.push(`## ${section.title}`, "", section.summary, "");
    for (const id of section.pages) {
      const [, title = id, lede = ""] = /^# (.+)\n\n(.+)\n/.exec(pages.get(id) ?? "") ?? [];
      out.push(`- [${title}](${id}.md): ${lede}`);
    }
    out.push("");
  }
  return out.join("\n");
}

/** The pages and README as `{ path: text }`, without writing anything. */
export async function build(options: Options = {}) {
  const docs = options.docs ?? join(root, "website/src/content/docs");
  const sections = options.sections ?? navSections;
  const manifest = options.manifest ?? join(root, "packages/core/package.json");
  const { version } = Manifest.parse(JSON.parse(readFileSync(manifest, "utf8")));

  const listed = sections.flatMap((section) => section.pages);
  const found = (await readdir(docs, { recursive: true }))
    .filter((name) => name.endsWith(".mdx"))
    .map((name) =>
      name
        .replace(/\.mdx$/, "")
        .split("\\")
        .join("/"),
    );
  for (const id of found) {
    if (!listed.includes(id)) throw new Error(`pack-docs: ${id}.mdx is not in the nav.`);
  }
  for (const id of listed) {
    if (!found.includes(id)) throw new Error(`pack-docs: the nav lists ${id}, which has no page.`);
  }

  const known = new Set(listed);
  const pages = new Map(
    listed.map((id) => [id, convertPage(id, readFileSync(join(docs, `${id}.mdx`), "utf8"), known)]),
  );
  const files: Record<string, string> = { "README.md": readme(version, sections, pages) };
  for (const [id, text] of pages) files[`${id}.md`] = text;
  return files;
}

/** Writes the documentation to `out`, replacing what it held, and returns the paths. */
export async function generate(out: string, options: Options = {}) {
  const files = await build(options);
  rmSync(out, { recursive: true, force: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(out, path)), { recursive: true });
    writeFileSync(join(out, path), text);
  }
  return Object.keys(files);
}

if (import.meta.main) {
  // The excerpts find the checkout from the working directory (website/src/lib/docs/source.ts).
  if (process.cwd() !== root)
    throw new Error(`pack-docs: run it from the repository root, ${root}.`);
  const out = resolve(process.argv[2] ?? join(root, "packages/core/docs"));
  const paths = await generate(out);
  console.log(`pack-docs: ${paths.length} files in ${out}`);
}
