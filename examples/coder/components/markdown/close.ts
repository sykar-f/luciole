/**
 * Optimistic closing of a streamed block (after Streamdown's `remend`): the tail of a reply
 * is Markdown cut anywhere. Left as is, `**bold` shows its markers until the closing `**`
 * arrives, then loses them: the line flashes. Closed here, it is bold from the first word.
 *
 * Only the last inline context (the last paragraph, list item or heading line) is closed:
 * markers can't span a blank line or a new item, so earlier ones stay as the final render
 * shows them. Heuristics follow CommonMark's flanking rules, loosely: an asterisk between
 * two word characters (`2*3`, `snake_case`) never opens, a list bullet is no emphasis.
 */

const WORD = /[\p{L}\p{N}_]/u;
const SPACE = /\s/;
const isWord = (char: string | undefined) => char !== undefined && WORD.test(char);
const isSpace = (char: string | undefined) => char === undefined || SPACE.test(char);

// A line that is only block syntax still being typed: a bullet, a heading's hashes, a fence,
// a rule or a quote marker. Shown, it would flash as text before its block takes shape.
const PENDING_LINE =
  /^\s*(?:[-*+]|\d{1,9}[.)]?|#{1,6}|`{1,2}|`{3,}[^`\s]*|~{1,2}|~{3,}[^~\s]*|>+|(?:[-*_=]\s*)+|\|.*)\s*$/;
// Where an inline context starts: a blank line, a list item, a heading or a quoted line.
const CONTEXT_START = /^(?: {0,3}>)* *(?:[-*+]|\d{1,9}[.)]|#{1,6})(?:\s|$)/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const AUTOLINK = /^[a-z][a-z0-9+.-]{1,31}:/i;

// `missing`: how many delimiters close it (fewer than `length` once half a closer arrived).
type Opener = { char: string; length: number; at: number; missing: number };
type Removal = { from: number; to: number };

/**
 * `text` as its end should read once complete: dangling openers dropped, open emphasis,
 * strikethrough and code spans closed, an unfinished link reduced to its label.
 */
export function closeTail(text: string): string {
  const lines = text.split("\n");
  const last = lines.at(-1) ?? "";
  // The unterminated last line waits for its newline when it is block syntax only.
  const body = last && PENDING_LINE.test(last) ? text.slice(0, -last.length) : text;
  if (insideFence(body)) return body;
  return closeInline(body);
}

/** Whether the end of `text` sits inside a fenced code block (nothing to close there). */
function insideFence(text: string) {
  let fence = "";
  for (const line of text.split("\n")) {
    const match = FENCE.exec(line.replace(/^(?: {0,3}>)+ ?/, "").trimStart());
    if (!match?.[1]) continue;
    const run = match[1];
    if (!fence) fence = run;
    else if (run[0] === fence[0] && run.length >= fence.length && line.trim() === run) fence = "";
  }
  return fence !== "";
}

/** The offset where the last inline context of `text` begins. */
function contextStart(text: string) {
  let offset = text.length;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    offset -= line.length + (i < lines.length - 1 ? 1 : 0);
    if (line.trim() === "") return offset + line.length + 1;
    if (CONTEXT_START.test(line)) return offset;
  }
  return 0;
}

function closeInline(text: string): string {
  const trimmed = text.replace(/\s+$/, "");
  const trailing = text.slice(trimmed.length);
  const start = Math.min(contextStart(trimmed), trimmed.length);
  const openers: Opener[] = [];
  const removals: Removal[] = [];
  let code: Opener | null = null;
  // `[` of links and images being written, and the `](` of the one whose URL is.
  const brackets: number[] = [];
  let url: { label: number; from: number } | null = null;
  let i = start;
  while (i < trimmed.length) {
    const char = trimmed[i] ?? "";
    if (url) {
      if (char === ")") url = null;
      i++;
      continue;
    }
    if (char === "\\") {
      i += 2;
      continue;
    }
    const run = runLength(trimmed, i);
    if (char === "`") {
      if (!code) code = { char, length: run, at: i, missing: run };
      else if (code.length === run) code = null;
      i += run;
      continue;
    }
    if (code) {
      i += run;
      continue;
    }
    if (char === "[" || (char === "!" && trimmed[i + 1] === "[")) {
      brackets.push(i);
      i += char === "!" ? 2 : 1;
      continue;
    }
    if (char === "]") {
      const label = brackets.pop();
      // `[label]` at the very end may be a link whose `(` has not arrived yet.
      if (label !== undefined && (trimmed[i + 1] === "(" || i + 1 === trimmed.length))
        url = { label, from: i };
      i++;
      continue;
    }
    if (char === "<" && AUTOLINK.test(trimmed.slice(i + 1)) && !trimmed.includes(">", i)) {
      // An autolink's brackets are hidden once it closes: hide them already.
      removals.push({ from: i, to: i + 1 });
      i++;
      continue;
    }
    if (char === "*" || char === "_" || char === "~") {
      const before = trimmed[i - 1];
      const after = trimmed[i + run];
      const bullet = char === "*" && isSpace(after) && /^\s*$/.test(lineText(trimmed, i));
      if (!bullet)
        emphasis(openers, removals, { char, length: run, at: i, missing: run }, before, after);
      i += run;
      continue;
    }
    i++;
  }
  let closers = "";
  if (url) {
    // A link whose URL is still coming shows its label alone, as it will before " (url)".
    removals.push({ from: url.from, to: trimmed.length });
    removals.push(bracketRemoval(trimmed, url.label));
  }
  for (const label of brackets) removals.push(bracketRemoval(trimmed, label));
  if (code) {
    if (code.at + code.length === trimmed.length)
      removals.push({ from: code.at, to: trimmed.length });
    else closers = code.char.repeat(code.length);
  }
  for (let o = openers.length - 1; o >= 0; o--) {
    const opener = openers[o];
    if (!opener) continue;
    // Nothing after the opener yet: drop it rather than close an empty span.
    if (/^\s*$/.test(trimmed.slice(opener.at + opener.length))) {
      removals.push({ from: opener.at, to: opener.at + opener.length });
      continue;
    }
    closers += opener.char.repeat(opener.missing);
  }
  return apply(trimmed, removals) + closers + trailing;
}

/** The text of the line holding offset `at`, up to it. */
const lineText = (text: string, at: number) => text.slice(text.lastIndexOf("\n", at - 1) + 1, at);

function runLength(text: string, at: number) {
  const char = text[at];
  let end = at;
  while (text[end] === char) end++;
  return end - at;
}

const bracketRemoval = (text: string, at: number): Removal => ({
  from: at,
  to: at + (text[at] === "!" ? 2 : 1),
});

/** Pushes, closes or completes an emphasis delimiter run. */
function emphasis(
  openers: Opener[],
  removals: Removal[],
  run: Opener,
  before: string | undefined,
  after: string | undefined,
) {
  const intraword = isWord(before) && isWord(after);
  // `snake_case`, `2*3`, `20~25`: never a delimiter.
  if (intraword) return;
  const canOpen = !isSpace(after) && !(run.char === "_" && isWord(before));
  const canClose = !isSpace(before) && !(run.char === "_" && isWord(after));
  const index = findLastIndex(openers, (o) => o.char === run.char);
  const opener = openers[index];
  if (canClose && opener) {
    // `**bold*` at the very end: the closing run is half there.
    if (run.length < opener.missing && after === undefined) {
      opener.missing -= run.length;
      return;
    }
    openers.splice(index);
    return;
  }
  if (canOpen) {
    openers.push({ ...run });
    return;
  }
  // A run that can do neither at the very end (`text **`) is an opener still waiting.
  if (after === undefined && isSpace(before))
    removals.push({ from: run.at, to: run.at + run.length });
}

function findLastIndex<T>(items: readonly T[], test: (item: T) => boolean) {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item !== undefined && test(item)) return i;
  }
  return -1;
}

function apply(text: string, removals: readonly Removal[]) {
  let result = text;
  const sorted = [...removals].sort((a, b) => b.from - a.from);
  let limit = Infinity;
  for (const { from, to } of sorted) {
    const end = Math.min(to, limit);
    if (end <= from) continue;
    result = result.slice(0, from) + result.slice(end);
    limit = from;
  }
  return result;
}
