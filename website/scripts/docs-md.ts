/**
 * The site's documentation (src/content/docs, in English) as plain Markdown, for mdreader
 * to read: its live demo (scripts/demo.ts) and its capture (scripts/capture.py) show it,
 * as the landing page is in English. The front matter becomes a title and a lede, the
 * imports go, and the components become what they say in Markdown: a note a quote, a
 * copyable command a shell block, an excerpt the path of its file. Fenced code is kept as
 * it is.
 *   bun website/scripts/docs-md.ts <directory>   # writes one .md per page
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { repo } from "../src/lib/links";
import { commands, envPrefix } from "../src/lib/product";

const docs = resolve(import.meta.dirname, "../src/content/docs");

/** What the pages' expressions read, as scripts in their front matter define them. */
const values: Record<string, string> = {
  repo,
  clone: repo.split("/").at(-1) ?? "",
  envPrefix,
  "commands.fromClone": commands.fromClone,
  "commands.cli": commands.cli,
  "commands.runner": commands.runner,
};
const evaluate = (expression: string) => values[expression] ?? expression;

/** `${name}` inside a template literal, and `"…"`, `'…'` or `` `…` `` strings, in order. */
function strings(source: string) {
  return [...source.matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`/g)].map((match) =>
    (match[1] ?? match[2] ?? match[3] ?? "").replace(/\$\{([\w.]+)\}/g, (_, name: string) =>
      evaluate(name),
    ),
  );
}

const attribute = (tag: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];

/** A component's tag, from `<Name` to the `/>` or `>` that closes it, maybe over lines. */
function component(lines: string[], at: number) {
  let end = at;
  while (end < lines.length && !/\/?>\s*;?\s*$/.test(lines[end] ?? "")) end++;
  return { tag: lines.slice(at, end + 1).join("\n"), end };
}

function prose(line: string) {
  return line
    .replace(/<Src path="([^"]+)"\s*\/>/g, "`$1`")
    .replace(/<kbd>(.*?)<\/kbd>/g, "`$1`")
    .replace(/<code>(.*?)<\/code>/g, "`$1`")
    .replace(/\{([\w.]+)\}/g, (whole, name: string) => (name in values ? evaluate(name) : whole));
}

/** A one-line YAML scalar: plain, or quoted (`''` inside single quotes is one `'`). */
function scalar(value: string | undefined) {
  const text = value?.trim();
  if (!text) return undefined;
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replaceAll("''", "'");
  if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1).replaceAll('\\"', '"');
  return text;
}

export function toMarkdown(mdx: string) {
  const [, front = "", body = mdx] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(mdx) ?? [];
  const title = scalar(/^title:\s*(.+)$/m.exec(front)?.[1]);
  const description = scalar(/^description:\s*(.+)$/m.exec(front)?.[1]);
  const out: string[] = [];
  if (title) out.push(`# ${title}`, "");
  if (description) out.push(description, "");
  const lines = body.split("\n");
  let fenced = false;
  let quoting = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced || /^\s*(```|~~~)/.test(line)) {
      out.push(quoting ? `> ${line}` : line);
      continue;
    }
    if (/^(import|export) /.test(line)) continue;
    const open = /^\s*<Note(?:\s+kind="(\w+)")?\s*>\s*$/.exec(line);
    if (open) {
      quoting = true;
      const kind = open[1] ?? "note";
      out.push(`> **${kind[0]?.toUpperCase()}${kind.slice(1)}:**`, ">");
      continue;
    }
    if (/^\s*<\/Note>\s*$/.test(line)) {
      quoting = false;
      continue;
    }
    const tag = /^\s*<([A-Z]\w*)/.exec(line)?.[1];
    if (tag) {
      const { tag: whole, end } = component(lines, i);
      i = end;
      if (tag === "CopyCommand") {
        const list = /lines=\{\[([\s\S]*)\]\}/.exec(whole)?.[1] ?? "";
        out.push("```sh", ...strings(list), "```");
      } else if (tag === "Excerpt") {
        const path = attribute(whole, "path");
        if (path) out.push(`From \`${path}\`.`);
      }
      continue;
    }
    out.push(quoting ? `> ${prose(line.trim())}`.trimEnd() : prose(line));
  }
  return `${out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;
}

/**
 * Every page, by its path under src/content/docs with a .md extension, and a README.md
 * that lists them: the document mdreader opens first.
 */
export async function documentation() {
  const pages: { path: string; text: string }[] = [];
  for (const name of await readdir(docs, { recursive: true })) {
    if (!name.endsWith(".mdx")) continue;
    const text = toMarkdown(await readFile(join(docs, name), "utf8"));
    pages.push({ path: name.replace(/\.mdx$/, ".md"), text });
  }
  pages.sort((a, b) => a.path.localeCompare(b.path));
  const contents = pages.map(({ path, text }) => {
    const [, title = path, lede = ""] = /^# (.+)\n\n(.+)\n/.exec(text) ?? [];
    return `- **${title}** (\`${path}\`): ${lede}`;
  });
  const readme = [
    "# The airtty documentation",
    "",
    "Build terminal apps with React: a server keeps the data, a native terminal client keeps typing and scrolling local.",
    "",
    ...contents,
    "",
  ].join("\n");
  return [{ path: "README.md", text: readme }, ...pages];
}

if (import.meta.main) {
  const out = process.argv[2];
  if (!out) throw new Error("usage: bun website/scripts/docs-md.ts <directory>");
  for (const page of await documentation()) {
    const path = join(out, page.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, page.text);
  }
  console.log(`docs-md: ${relative(process.cwd(), resolve(out)) || "."}`);
}
