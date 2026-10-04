/**
 * The prose lint of the docs: the measurable rules of website/STYLE.md, checked on the /docs
 * pages and the README. Front matter, imports, fenced code, tables, HTML blocks and JSX tags
 * are set aside; the Markdown inside a component (a Note's text) is prose and is checked.
 *   bun website/scripts/prose-lint.ts [paths]   # files or directories, all pages by default
 *
 * It prints one `path:line rule` per finding, then applies the ratchet of
 * prose-allowlist.json to the files it read: a file that is not listed must have no
 * finding, and a listed file must have exactly its count, so that a file that improves
 * locks its gain. The exit code is 1 when the ratchet fails.
 *
 * A finding can be silenced, with its reason, by a comment on the line before it:
 *   {/* prose-lint: allow long-sentence — a command's flags read as one unit *\/}
 * (`<!-- … -->` in a .md file). An exception that silences nothing is a finding itself.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { z } from "zod";

export const root = resolve(import.meta.dirname, "../..");
export const allowlistPath = resolve(import.meta.dirname, "prose-allowlist.json");
const docs = join(root, "website/src/content/docs");

const MAX_PARAGRAPH_WORDS = 60;
const MAX_SENTENCE_WORDS = 30;

export const rules = [
  "long-paragraph",
  "long-sentence",
  "chained-clauses",
  "split-paragraph",
  "bad-allow",
  "unused-allow",
] as const;
export type Rule = (typeof rules)[number];

export interface Finding {
  path: string;
  line: number;
  rule: Rule;
  detail: string;
}

const isRule = (name: string): name is Rule => rules.some((rule) => rule === name);

/** A run of prose lines that renders as one paragraph or one list item. */
interface Block {
  lines: { line: number; text: string }[];
}

const FENCE = /^(`{3,}|~{3,})/;
const LIST_ITEM = /^([-*+]|\d+[.)])\s+/;
/** Tags that sit inside a sentence: a line that starts with one is prose. */
const INLINE_TAG = /^<\/?(kbd|code|Src|a|em|strong|b|i|br|sup|sub|abbr|span)\b/;
const COMMENT_ONLY = /^(\{\/\*.*\*\/\}|<!--.*-->)$/;
const ALLOW = /prose-lint:\s*allow\s+([\w-]+)\s*(?:—|--?)\s*(\S.*?)\s*(?:\*\/\}|-->)/;

/**
 * Splits a page into prose blocks, and records the exception comments by line. Lines are
 * 1-based, as an editor shows them.
 */
function blocks(source: string) {
  const lines = source.split("\n");
  const found: Block[] = [];
  const comments: { line: number; text: string }[] = [];
  let current: Block | undefined;
  let fence: string | undefined;
  let skipUntil: RegExp | undefined;
  let htmlBlock = false;
  const close = () => {
    if (current) found.push(current);
    current = undefined;
  };

  let at = 0;
  if (lines[0]?.trim() === "---") {
    at = lines.findIndex((line, index) => index > 0 && line.trim() === "---") + 1;
  }
  for (; at < lines.length; at++) {
    const raw = lines[at] ?? "";
    const text = raw.trim();
    const line = at + 1;

    if (fence) {
      if (text.startsWith(fence)) fence = undefined;
      continue;
    }
    if (skipUntil) {
      if (skipUntil.test(text)) skipUntil = undefined;
      continue;
    }
    if (htmlBlock) {
      if (text === "") htmlBlock = false;
      continue;
    }
    if (text.includes("prose-lint:")) comments.push({ line, text });
    if (COMMENT_ONLY.test(text)) continue;
    if (text === "") {
      close();
      continue;
    }
    const opening = FENCE.exec(text);
    if (opening) {
      close();
      fence = opening[1];
      continue;
    }
    if (/^(import|export)\s/.test(raw)) {
      close();
      if (!/;\s*$/.test(text)) skipUntil = /;\s*$/;
      continue;
    }
    if (text.startsWith("#") || text.startsWith("|")) {
      close();
      continue;
    }
    if (text.startsWith("<") && !INLINE_TAG.test(text)) {
      close();
      // A component's tag, maybe over several lines: its children are Markdown, checked.
      if (/^<\/?[A-Z]/.test(text)) {
        if (!/>\s*$/.test(text)) skipUntil = />\s*$/;
      } else htmlBlock = true;
      continue;
    }
    if (text.startsWith(">")) {
      current ??= { lines: [] };
      current.lines.push({ line, text: text.replace(/^>\s?/, "") });
      continue;
    }
    if (LIST_ITEM.test(text)) {
      close();
      current = { lines: [{ line, text: text.replace(LIST_ITEM, "") }] };
      continue;
    }
    current ??= { lines: [] };
    current.lines.push({ line, text });
  }
  close();
  return { blocks: found, comments };
}

/** `length` characters that count as one word, carry no punctuation and can start a sentence. */
const word = (length: number) => `X${"x".repeat(length - 1)}`;
const blank = (length: number) => " ".repeat(length);

/**
 * The block's text with the same offsets, where code, expressions, URLs and tags no longer
 * count as punctuation or as several words: a code span is one word, a link is its text.
 */
function plain(text: string) {
  return text
    .replace(/\{\/\*[\s\S]*?\*\/\}|<!--[\s\S]*?-->/g, (match) => blank(match.length))
    .replace(/(`+)[\s\S]*?\1/g, (match) => word(match.length))
    .replace(/\{[^{}]*\}/g, (match) => word(match.length))
    .replace(/<[A-Z][^>]*\/>/g, (match) => word(match.length))
    .replace(/<\/?[a-zA-Z][^>]*>/g, (match) => blank(match.length))
    .replace(/\]\([^)]*\)|\]\[[^\]]*\]/g, (match) => blank(match.length))
    .replace(/\[/g, " ")
    .replace(/\b[a-z][\w+.-]*:\/\/\S+/g, (match) => word(match.length))
    .replace(/\b(e\.g|i\.e|cf|vs|etc)\./g, (match) => match.replaceAll(".", "_"));
}

const words = (text: string) => text.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token));

/** Sentence starts, as offsets into the block's text. */
function sentences(text: string) {
  const starts = [0];
  for (const match of text.matchAll(/[.!?…][)\]"'*_]*\s+(?=[^\s\p{Ll}])/gu))
    starts.push((match.index ?? 0) + match[0].length);
  return starts.map((start, index) => text.slice(start, starts[index + 1] ?? text.length));
}

/** Prose that ends a sentence, or a clause that announces what follows. */
const ENDS_SENTENCE = /[.!?:…][)\]"'*_`]*$/;
/** What starts the second half of a sentence cut by a blank line. */
const CONTINUES = /^(<(kbd|code|Src)\b|\p{Ll})/u;

/** Lints one page; `path` is how its findings name it, relative to the repository. */
export function lintSource(path: string, source: string): Finding[] {
  const { blocks: found, comments } = blocks(source);
  const findings: Finding[] = [];
  const report = (line: number, rule: Rule, detail: string) =>
    findings.push({ path, line, rule, detail });

  for (const block of found) {
    const first = block.lines[0];
    if (!first) continue;
    const joined = block.lines.map(({ text }) => text).join("\n");
    const text = plain(joined);
    const count = words(text).length;
    if (count > MAX_PARAGRAPH_WORDS) report(first.line, "long-paragraph", `${count} words`);

    let offset = 0;
    for (const sentence of sentences(text)) {
      const line = first.line + joined.slice(0, offset).split("\n").length - 1;
      offset += sentence.length;
      const length = words(sentence).length;
      if (length > MAX_SENTENCE_WORDS) report(line, "long-sentence", `${length} words`);
      const semicolons = sentence.split(";").length - 1;
      const colons = sentence.split(":").length - 1;
      if (semicolons > 1 || (semicolons > 0 && colons > 0))
        report(line, "chained-clauses", `${semicolons} semicolons, ${colons} colons`);
    }
  }

  // A blank line inside a sentence: MDX renders the rest as a new paragraph.
  const lines = source.split("\n");
  for (const [index, block] of found.entries()) {
    const previous = found[index - 1];
    const first = block.lines[0];
    const last = previous?.lines.at(-1);
    if (!first || !last) continue;
    const between = lines.slice(last.line, first.line - 1);
    if (!between.every((line) => line.trim() === "" || COMMENT_ONLY.test(line.trim()))) continue;
    if (!lines[first.line - 1]?.trim().match(CONTINUES)) continue;
    if (LIST_ITEM.test(lines[first.line - 1]?.trim() ?? "")) continue;
    if (!ENDS_SENTENCE.test(last.text))
      report(first.line, "split-paragraph", `after line ${last.line}`);
  }

  return exceptions(path, findings, comments);
}

/** Applies the `prose-lint: allow` comments: each silences one finding on the next line. */
function exceptions(path: string, findings: Finding[], comments: { line: number; text: string }[]) {
  const kept = [...findings];
  const added: Finding[] = [];
  for (const comment of comments) {
    const match = ALLOW.exec(comment.text);
    const rule = match?.[1];
    if (!rule || !isRule(rule)) {
      added.push({
        path,
        line: comment.line,
        rule: "bad-allow",
        detail: "write `prose-lint: allow <rule> — <reason>`",
      });
      continue;
    }
    const silenced = kept.findIndex(
      (finding) => finding.line === comment.line + 1 && finding.rule === rule,
    );
    if (silenced === -1)
      added.push({ path, line: comment.line, rule: "unused-allow", detail: `no ${rule} below` });
    else kept.splice(silenced, 1);
  }
  return [...kept, ...added].sort((a, b) => a.line - b.line);
}

function pages(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return pages(path);
      return /\.mdx?$/.test(entry.name) ? [path] : [];
    })
    .sort();
}

/** The files a run reads: the given files and directories, or every page and the README. */
export function targets(paths: string[] = []) {
  const given =
    paths.length > 0 ? paths.map((path) => resolve(path)) : [docs, join(root, "README.md")];
  return given.flatMap((path) => (statSync(path).isDirectory() ? pages(path) : [path]));
}

/** Each file that does not pass yet, with its count of findings. */
const Allowlist = z.record(z.string(), z.number().int().positive());
export type Allowlist = z.infer<typeof Allowlist>;

export function readAllowlist(path = allowlistPath): Allowlist {
  return Allowlist.parse(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * What the ratchet refuses, one message per file. `checked` are the files the run read,
 * relative to the repository. A listed file the run did not read is a page that is gone or
 * that the lint does not cover: it leaves the list too.
 */
export function ratchet(findings: Finding[], allowlist: Allowlist, checked: string[]) {
  const counts = new Map<string, number>();
  for (const { path } of findings) counts.set(path, (counts.get(path) ?? 0) + 1);
  const errors: string[] = [];
  for (const path of [...new Set([...checked, ...Object.keys(allowlist)])].sort()) {
    const count = counts.get(path) ?? 0;
    const allowed = allowlist[path];
    if (allowed === undefined) {
      if (count > 0)
        errors.push(`${path}: ${count} findings, and the file is not on the allowlist`);
    } else if (!checked.includes(path)) {
      errors.push(`${path}: not a page the lint reads, remove it from the allowlist`);
    } else if (count === 0) {
      errors.push(`${path}: no finding left, remove it from the allowlist`);
    } else if (count > allowed) {
      errors.push(`${path}: ${count} findings, the allowlist allows ${allowed}`);
    } else if (count < allowed) {
      errors.push(`${path}: ${count} findings, lower its count from ${allowed} to ${count}`);
    }
  }
  return errors;
}

/**
 * Lints the given paths (every page and the README by default) and judges them against the
 * allowlist. A run on some paths judges only their entries.
 */
export function run(paths: string[] = [], allowlist = readAllowlist()) {
  const files = targets(paths).map((file) => relative(root, file));
  const findings = files.flatMap((file) =>
    lintSource(file, readFileSync(join(root, file), "utf8")),
  );
  const judged =
    paths.length === 0
      ? allowlist
      : Object.fromEntries(Object.entries(allowlist).filter(([path]) => files.includes(path)));
  return { files, findings, errors: ratchet(findings, judged, files) };
}

if (import.meta.main) {
  const { files, findings, errors } = run(process.argv.slice(2));
  for (const { path, line, rule, detail } of findings)
    console.log(`${path}:${line} ${rule} (${detail})`);
  for (const error of errors) console.error(`prose-lint: ${error}`);
  console.error(
    `prose-lint: ${findings.length} findings in ${files.length} files, ${errors.length} ratchet errors`,
  );
  process.exitCode = errors.length > 0 ? 1 : 0;
}
