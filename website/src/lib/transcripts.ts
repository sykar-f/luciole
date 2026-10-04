// The text of the site's figures: what a screen reader reads in place of the drawing, and
// what the Markdown export (scripts/docs-md.ts) prints for it. Plain TypeScript, with no
// Vite in it: the export and the tests run it under Bun.
import type { Tone } from "./guide/tones";

// ── Screens ──────────────────────────────────────────────────────────────────

export type Run = [text: string, fg: string | null, bg: string | null, flags: string];
/** Numbered callouts the capture located on its screen: the cells of one piece of the interface. */
export type FrameRegion = {
  id: string;
  side: "client" | "server";
  rects: { row: number; col: number; rows: number; cols: number }[];
};
export type Frame = {
  title: string;
  cols: number;
  rows: number;
  cells: Run[][];
  regions?: FrameRegion[];
};

/** The text of each row, without its trailing blanks. */
export const lines = (frame: Frame) =>
  frame.cells.map((runs) =>
    runs
      .map(([t]) => t)
      .join("")
      .trimEnd(),
  );

// The text of a frame, for screen readers and search engines: its blank rows above and
// below go, the columns stay where they are.
export function text(frame: Frame) {
  return lines(frame)
    .join("\n")
    .replace(/^\n+|\s+$/g, "");
}

// ── Sequences ────────────────────────────────────────────────────────────────

export interface Lane {
  id: string;
  label: string;
  sub?: string;
  tone: Tone;
}

export type Message =
  | { from: string; to: string; label: string; n?: number; back?: boolean; tone?: Tone }
  | { phase: string };

export type Step = { n: number; text: string };

/**
 * A sequence's messages as sentences, in order, under the phase each falls in: "Client →
 * Server: GET /render", or "Server: render the page" for a step on one lane. Each is
 * numbered as its badge in the drawing; one without a badge takes the number after the
 * one before.
 */
export function steps(title: string, lanes: Lane[], messages: Message[]) {
  const label = (id: string) => {
    const lane = lanes.find((candidate) => candidate.id === id);
    if (!lane) throw new Error(`Sequence « ${title} »: unknown lane ${id}`);
    return lane.label;
  };
  const groups: { phase?: string; steps: Step[] }[] = [{ steps: [] }];
  let last = 0;
  for (const message of messages) {
    if ("phase" in message) {
      groups.push({ phase: message.phase, steps: [] });
      continue;
    }
    const who =
      message.from === message.to
        ? label(message.from)
        : `${label(message.from)} → ${label(message.to)}`;
    last = message.n ?? last + 1;
    groups.at(-1)?.steps.push({ n: last, text: `${who}: ${message.label}` });
  }
  return groups.filter((group) => group.phase !== undefined || group.steps.length > 0);
}

// ── Annotated captures ───────────────────────────────────────────────────────

export type Annotation = { match: string; note: string };

/**
 * Where each annotation's text first appears in the capture, numbered in the order given.
 * A text the capture no longer holds fails the build, as an Excerpt's missing mark does:
 * the capture changed, so the note may be wrong.
 */
export function locate(capture: string, annotations: Annotation[], source: string) {
  const found = annotations.map(({ match, note }, i) => {
    const start = capture.indexOf(match);
    if (!match || start === -1) {
      throw new Error(
        `AnnotatedCapture: ${JSON.stringify(match)} is not in ${source}. The capture changed: update its annotations.`,
      );
    }
    return { n: i + 1, match, note, start, end: start + match.length };
  });
  const ordered = found.toSorted((a, b) => a.start - b.start);
  for (const [i, current] of ordered.entries()) {
    const previous = ordered[i - 1];
    if (previous && current.start < previous.end) {
      throw new Error(
        `AnnotatedCapture: ${JSON.stringify(previous.match)} and ${JSON.stringify(current.match)} overlap in ${source}.`,
      );
    }
  }
  return { annotations: found, ordered };
}

// ── Ids ──────────────────────────────────────────────────────────────────────

const taken = new WeakMap<WeakKey, Set<string>>();

/**
 * `base`, or `base-2`, `base-3`… for the next figure that asks for it on the same page:
 * `page` is an object that page's render shares (Astro.locals), so two screens of one
 * capture each describe themselves by their own transcript.
 */
export function uniqueId(page: WeakKey, base: string) {
  const ids = taken.get(page) ?? new Set<string>();
  taken.set(page, ids);
  let id = base;
  for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
  ids.add(id);
  return id;
}
