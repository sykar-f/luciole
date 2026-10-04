/**
 * The site's documentation (src/content/docs, in English) as plain Markdown, for mdreader
 * to read: its live demo (scripts/demo.ts) and its capture (scripts/capture.py) show it,
 * as the landing page is in English. The front matter becomes a title and a lede, the
 * imports go, and the components become what they say in Markdown: a note a quote, a
 * copyable command a shell block, an excerpt its code, a screen its transcript, a sequence
 * its steps, a capture its text and notes, each figure with its caption. A component this
 * script has no Markdown for stops it: the page would lose what the component says.
 * Fenced code is kept as it is.
 *   bun website/scripts/docs-md.ts <directory>   # writes one .md per page
 */
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";
import { excerpt, whole } from "../src/lib/guide/source";
import { repo } from "../src/lib/links";
import { commands, envPrefix } from "../src/lib/product";
import { locate, steps, text, type Frame } from "../src/lib/transcripts";

const docs = resolve(import.meta.dirname, "../src/content/docs");
const frames = resolve(import.meta.dirname, "../src/frames");
/** How much of a page's source an error quotes. */
const QUOTED = 40;

/** What the pages' expressions read, as scripts in their front matter define them. */
const values: Record<string, string> = {
  repo,
  clone: repo.split("/").at(-1) ?? "",
  envPrefix,
  "commands.fromNpm": commands.fromNpm,
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

// ── A component's props, read from the page ──────────────────────────────────

/** Where the string that opens at `at` (its quote) ends, past its closing quote. */
function skipString(source: string, at: number) {
  const quote = source[at];
  let i = at + 1;
  while (i < source.length && source[i] !== quote) i += source[i] === "\\" ? 2 : 1;
  return i + 1;
}

/** Where the `{…}` that opens at `at` ends, past its closing brace; strings inside skipped. */
function skipBraces(source: string, at: number) {
  let depth = 0;
  let i = at;
  while (i < source.length) {
    const char = source[i];
    if (char === '"' || char === "'" || char === "`") {
      i = skipString(source, i);
      continue;
    }
    if (char === "{") depth++;
    if (char === "}" && --depth === 0) return i + 1;
    i++;
  }
  throw new Error(`docs-md: an expression never closes: ${source.slice(at, at + QUOTED)}…`);
}

/** A component's tag, from `<Name` to the `/>` or `>` that closes it, maybe over lines. */
function component(lines: string[], at: number) {
  const rest = lines.slice(at).join("\n");
  let i = rest.indexOf("<") + 1;
  while (i < rest.length && rest[i] !== ">") {
    const char = rest[i];
    if (char === "{") i = skipBraces(rest, i);
    else if (char === '"' || char === "'") i = skipString(rest, i);
    else i++;
  }
  const tag = rest.slice(0, i + 1);
  return { tag, end: at + tag.split("\n").length - 1 };
}

/**
 * A JavaScript literal, as the pages write props: strings, numbers, booleans, arrays and
 * objects, and `${name}` in a template literal when `values` knows the name. Anything else
 * (a variable, a call) throws: the export cannot know its value.
 */
export function literal(source: string): unknown {
  let at = 0;
  const fail = (what: string): never => {
    throw new Error(`docs-md: ${what} in ${JSON.stringify(source.slice(at, at + QUOTED))}`);
  };
  const space = () => {
    while (/\s/.test(source[at] ?? "")) at++;
  };
  const string = () => {
    const quote = source[at];
    let out = "";
    at++;
    while (source[at] !== quote) {
      if (at >= source.length) fail("an unclosed string");
      const char = source[at] ?? "";
      if (char === "\\") {
        const next = source[at + 1] ?? "";
        out += next === "n" ? "\n" : next === "t" ? "\t" : next;
        at += 2;
      } else if (quote === "`" && source.startsWith("${", at)) {
        const end = source.indexOf("}", at);
        const name = source.slice(at + 2, end).trim();
        if (!(name in values)) fail(`an unknown \${${name}}`);
        out += evaluate(name);
        at = end + 1;
      } else {
        out += char;
        at++;
      }
    }
    at++;
    return out;
  };
  const value = (): unknown => {
    space();
    const char = source[at];
    if (char === '"' || char === "'" || char === "`") return string();
    if (char === "[") {
      at++;
      const items: unknown[] = [];
      for (space(); source[at] !== "]"; space()) {
        items.push(value());
        space();
        if (source[at] === ",") at++;
        else if (source[at] !== "]") fail("a list without , or ]");
      }
      at++;
      return items;
    }
    if (char === "{") {
      at++;
      const entries: Record<string, unknown> = {};
      for (space(); source[at] !== "}"; space()) {
        const quoted = /^["']/.test(source[at] ?? "");
        const key = quoted ? string() : /^[A-Za-z_$][\w$]*/.exec(source.slice(at))?.[0];
        if (key === undefined) return fail("an object key");
        if (!quoted) at += key.length;
        space();
        if (source[at] !== ":") fail("a key without :");
        at++;
        entries[key] = value();
        space();
        if (source[at] === ",") at++;
        else if (source[at] !== "}") fail("an object without , or }");
      }
      at++;
      return entries;
    }
    const word = /^(-?\d+(?:\.\d+)?|true|false|null)\b/.exec(source.slice(at))?.[0];
    if (word === undefined) return fail("a value that is not a literal");
    at += word.length;
    return word === "true"
      ? true
      : word === "false"
        ? false
        : word === "null"
          ? null
          : Number(word);
  };
  const result = value();
  space();
  if (at < source.length) fail("more after the value");
  return result;
}

/** The props of a component's tag: `name="…"`, `name='…'`, `name={literal}`, or `name`. */
export function attributes(tag: string) {
  const props: Record<string, unknown> = {};
  let i = /^\s*<[A-Z]\w*/.exec(tag)?.[0].length ?? 0;
  while (i < tag.length) {
    const name = /^\s*([A-Za-z_][\w-]*)/.exec(tag.slice(i));
    if (!name?.[1]) break;
    i += name[0].length;
    if (tag[i] !== "=") {
      props[name[1]] = true;
      continue;
    }
    i++;
    const char = tag[i];
    if (char === '"' || char === "'") {
      const end = skipString(tag, i);
      props[name[1]] = tag.slice(i + 1, end - 1);
      i = end;
    } else if (char === "{") {
      const end = skipBraces(tag, i);
      props[name[1]] = literal(tag.slice(i + 1, end - 1));
      i = end;
    }
  }
  return props;
}

// ── Each figure in Markdown ──────────────────────────────────────────────────

const Tone = z.enum(["client", "server", "wire", "build", "neutral"]);
const Caption = z.string().trim().min(1);
const ExcerptProps = z.object({
  path: z.string(),
  find: z.optional(z.string()),
  until: z.optional(z.string()),
  count: z.optional(z.number()),
  after: z.optional(z.string()),
  tone: z.optional(Tone),
  lang: z.optional(z.string()),
  caption: z.optional(z.string()),
});
const FrameFile = z.object({
  title: z.string(),
  cols: z.number(),
  rows: z.number(),
  cells: z.array(
    z.array(z.tuple([z.string(), z.nullable(z.string()), z.nullable(z.string()), z.string()])),
  ),
});
const ScreenProps = z.object({ frame: z.string(), caption: Caption });
const SequenceProps = z.object({
  title: z.string(),
  caption: Caption,
  lanes: z.array(
    z.object({ id: z.string(), label: z.string(), sub: z.optional(z.string()), tone: Tone }),
  ),
  messages: z.array(
    z.union([
      z.object({ phase: z.string() }),
      z.object({
        from: z.string(),
        to: z.string(),
        label: z.string(),
        n: z.optional(z.number()),
        back: z.optional(z.boolean()),
        tone: z.optional(Tone),
      }),
    ]),
  ),
});
const CaptureProps = z.object({
  path: z.string(),
  caption: Caption,
  notes: z.array(z.object({ match: z.string(), note: z.string() })),
});
const sides = { client: "Client", server: "Server", wire: "Wire", build: "Build", neutral: "" };

/** A fenced block, with a fence longer than any run of backticks inside. */
function fence(lang: string, code: string) {
  const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map(([run]) => run.length));
  const marks = "`".repeat(longest + 1);
  return [`${marks}${lang}`, code, marks];
}

const captioned = (caption: string | undefined) => (caption ? ["", `*${caption}*`] : []);

function frameNamed(name: string): Frame {
  return FrameFile.parse(JSON.parse(readFileSync(join(frames, `${name}.json`), "utf8")));
}

function screen(name: string) {
  const frame = frameNamed(name);
  return [`The screen “${frame.title}”, as text:`, "", ...fence("text", text(frame))];
}

function code(props: unknown) {
  const {
    path,
    find,
    until,
    count,
    after,
    tone = "neutral",
    lang,
    caption,
  } = ExcerptProps.parse(props);
  const picked =
    find === undefined
      ? { code: whole(path), start: 1, end: whole(path).split("\n").length }
      : excerpt(path, { find, until, count, after });
  const language =
    lang ?? (path.endsWith(".rs") ? "rust" : path.endsWith(".json") ? "json" : "tsx");
  const lines =
    picked.start === picked.end ? `line ${picked.start}` : `lines ${picked.start}–${picked.end}`;
  const side = sides[tone] ? `, ${sides[tone]} side` : "";
  return {
    lines: [`From \`${path}\`, ${lines}${side}:`, "", ...fence(language, picked.code)],
    caption,
  };
}

/** A figure component in Markdown, or undefined for a tag this script does not know. */
function figure(name: string, props: Record<string, unknown>): string[] | undefined {
  switch (name) {
    case "Excerpt": {
      const { lines, caption } = code(props);
      return [...lines, ...captioned(caption)];
    }
    case "Screen": {
      const { frame, caption } = ScreenProps.parse(props);
      return [...screen(frame), ...captioned(caption)];
    }
    case "Sequence": {
      const { title, caption, lanes, messages } = SequenceProps.parse(props);
      const groups = steps(title, lanes, messages).flatMap((group) => [
        ...(group.phase ? ["", `**${group.phase}**`, ""] : []),
        ...group.steps.map((step) => `${step.n}. ${step.text}`),
      ]);
      return [
        `${title}, step by step:`,
        ...(groups[0] === "" ? groups : ["", ...groups]),
        ...captioned(caption),
      ];
    }
    case "AnnotatedCapture": {
      const { path, caption, notes } = CaptureProps.parse(props);
      const capture = whole(path);
      const { annotations } = locate(capture, notes, path);
      return [
        ...fence("text", capture),
        ...captioned(caption),
        "",
        ...annotations.map(({ n, match, note }) => `${n}. \`${match}\` ${note}`),
      ];
    }
    case "CodeAndScreen": {
      const { lines } = code({ ...props, caption: undefined });
      const { frame, caption } = ScreenProps.parse(props);
      return [...lines, "", ...screen(frame), ...captioned(caption)];
    }
    case "RunHere": {
      const { frame, caption } = ScreenProps.parse(props);
      return [...screen(frame), ...captioned(caption)];
    }
    default:
      return undefined;
  }
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

export function toMarkdown(mdx: string, page = "a page") {
  const [, front = "", body = mdx] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(mdx) ?? [];
  const title = scalar(/^title:\s*(.+)$/m.exec(front)?.[1]);
  const description = scalar(/^description:\s*(.+)$/m.exec(front)?.[1]);
  const out: string[] = [];
  if (title) out.push(`# ${title}`, "");
  if (description) out.push(description, "");
  const lines = body.split("\n");
  let fenced = false;
  let quoting = false;
  // A block inside a Note stays inside its quote.
  const quoted = (block: string[]) =>
    quoting ? block.map((line) => `> ${line}`.trimEnd()) : block;
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
        out.push(...quoted(["```sh", ...strings(list), "```"]));
        continue;
      }
      const markdown = figure(tag, attributes(whole));
      if (!markdown) {
        throw new Error(
          `docs-md: <${tag}> in ${page} has no Markdown form. Give it one in website/scripts/docs-md.ts.`,
        );
      }
      out.push(...quoted(markdown));
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
    const text = toMarkdown(await readFile(join(docs, name), "utf8"), name);
    pages.push({ path: name.replace(/\.mdx$/, ".md"), text });
  }
  pages.sort((a, b) => a.path.localeCompare(b.path));
  const contents = pages.map(({ path, text }) => {
    const [, title = path, lede = ""] = /^# (.+)\n\n(.+)\n/.exec(text) ?? [];
    return `- **${title}** (\`${path}\`): ${lede}`;
  });
  const readme = [
    "# The luciole documentation",
    "",
    "React Server Components for the terminal: a server keeps the data, a native terminal client keeps typing and scrolling local.",
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
