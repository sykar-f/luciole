/**
 * How the wheel scrolls a Markdown document in a real terminal, measured: the built Client
 * of Notes (its long note) or mdreader (a long document of docs/) on a PTY, wheel reports
 * written as a terminal writes them (SGR, one per notch or per line of a trackpad), and
 * scripts/pty/scroll-probe.ts preloaded in it. For each gesture: the wheel events OpenTUI
 * dispatched, the React commits they caused (and which components rendered), the frames
 * drawn, their time (JavaScript and native) and the bytes written to the terminal.
 * The counterpart of scripts/web/scroll-bench.ts, in a browser.
 *
 *   bun scripts/pty/scroll-bench.ts [--app notes|mdreader] [--cols 84 --rows 24] [--no-build]
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import * as z from "zod/mini";
import { drive, type Driver } from "./driver";
import { BUN, ROOT, build, example, report, startServer, temporaryDirectory } from "./harness";

const { values: args } = parseArgs({
  options: {
    app: { type: "string", default: "notes" },
    cols: { type: "string", default: "84" },
    rows: { type: "string", default: "24" },
    "no-build": { type: "boolean", default: false },
  },
});
const COLS = Number(args.cols);
const ROWS = Number(args.rows);
const APP = example(args.app);
const ESC = "\x1b";
const FRAME_BEGIN = `${ESC}[?2026h`;
// The bench's windows, not waits for an effect: what a gesture causes within this long is
// what it measures (it asserts nothing).
const SETTLE_MS = 400;
const PROBE = join(import.meta.dir, "scroll-probe.ts");
/** A wheel report at a cell, 1-based: 64 up, 65 down. */
const wheel = (down: boolean, column: number, row: number) =>
  `${ESC}[<${down ? 65 : 64};${column};${row}M`;

/**
 * Gestures as terminals send them: a mouse notch is one report; a trackpad sends one per
 * line its pixels add up to, at the rate the hand moves (a fast swipe, several in one read).
 */
type Gesture = { name: string; bursts: { reports: number; gapMs: number }[] };
const GESTURES: Gesture[] = [
  { name: "notch", bursts: [{ reports: 1, gapMs: 0 }] },
  { name: "notches", bursts: Array.from({ length: 10 }, () => ({ reports: 1, gapMs: 60 })) },
  { name: "swipe", bursts: Array.from({ length: 45 }, () => ({ reports: 1, gapMs: 8 })) },
  { name: "flick", bursts: Array.from({ length: 15 }, () => ({ reports: 4, gapMs: 8 })) },
];

const Entry = z.object({
  at: z.number(),
  kind: z.string(),
  ms: z.optional(z.number()),
  nativeMs: z.optional(z.number()),
  components: z.optional(z.array(z.string())),
});
/** What the probe wrote, none when it wrote nothing. */
const entries = (file: string) =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => Entry.parse(JSON.parse(line)))
    : [];

if (!args["no-build"]) build(APP);
using directory = temporaryDirectory("scroll-bench-");
const probeOut = join(directory.path, "probe.jsonl");
await using server = await startServer(APP, {
  NOTES_DB: join(directory.path, "notes.sqlite"),
  MD_PATH: join(ROOT, "docs"),
});
await using t = await drive({
  command: [BUN, join(APP, ".luciole/client/index.js"), "--url", server.url],
  cols: COLS,
  rows: ROWS,
  env: {
    NODE_ENV: "production",
    XDG_STATE_HOME: join(directory.path, "state"),
    BUN_OPTIONS: `--preload=${PROBE}`,
    SCROLL_PROBE_OUT: probeOut,
  },
  settle: 150,
});

/** Opens the long document, and says over which cell the wheel turns. */
async function open(t: Driver) {
  if (args.app === "notes") {
    await t.waitFor("Markdown, the w");
    await t.click("Markdown, the w");
    await t.waitFor("Every construct of CommonMark");
    const lines = await t.lines();
    const row = lines.findIndex((line) => line.includes("Every construct"));
    return { column: (lines[row]?.indexOf("Every construct") ?? 0) + 5, row: row + 1 };
  }
  // docs/API.md, the first document: long, with tables and code.
  await t.waitFor("API applicative minimale");
  return { column: Math.round(COLS * 0.7), row: Math.round(ROWS / 2) };
}

const at = await open(t);
await t.pause(SETTLE_MS * 2);
const results: Record<string, unknown> = {};
for (const gesture of GESTURES) {
  // From the top each time.
  t.write(wheel(false, at.column, at.row).repeat(200));
  await t.pause(SETTLE_MS);
  rmSync(probeOut, { force: true });
  t.markOutput();
  const started = performance.now();
  for (const { reports, gapMs } of gesture.bursts) {
    t.write(wheel(true, at.column, at.row).repeat(reports));
    // The gesture's own rhythm: the time between two reads of a moving hand.
    if (gapMs) await t.pause(gapMs);
  }
  const sentMs = performance.now() - started;
  await t.pause(SETTLE_MS);
  const output = t.output();
  const frames = output.split(FRAME_BEGIN).slice(1);
  const bytes = frames.map((frame) => Buffer.byteLength(frame));
  const probe = entries(probeOut);
  const drawn = probe.filter((e) => e.kind === "frame");
  const commits = probe.filter((e) => e.kind === "commit");
  const rendered = new Map<string, number>();
  for (const commit of commits)
    for (const name of commit.components ?? []) rendered.set(name, (rendered.get(name) ?? 0) + 1);
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  const round = (ms: number) => Math.round(ms * 100) / 100;
  results[gesture.name] = {
    reports: sum(gesture.bursts.map((b) => b.reports)),
    sentOverMs: Math.round(sentMs),
    wheelEvents: probe.filter((e) => e.kind === "wheel").length,
    frames: drawn.length,
    terminalFrames: frames.length,
    // In the Client: from the first wheel event OpenTUI dispatched to the end of the frame
    // that drew it.
    wheelToFrameMs: round(
      (drawn[0]?.at ?? NaN) - (probe.find((e) => e.kind === "wheel")?.at ?? NaN),
    ),
    frameMs: {
      mean: round(sum(drawn.map((f) => f.ms ?? 0)) / (drawn.length || 1)),
      max: round(Math.max(0, ...drawn.map((f) => f.ms ?? 0))),
      nativeMean: round(sum(drawn.map((f) => f.nativeMs ?? 0)) / (drawn.length || 1)),
    },
    bytes: { total: sum(bytes), perFrame: Math.round(sum(bytes) / (bytes.length || 1)) },
    reactCommits: commits.length,
    rendered: Object.fromEntries([...rendered].sort((a, b) => b[1] - a[1]).slice(0, 8)),
  };
}
report({ app: args.app, cols: COLS, rows: ROWS, gestures: results });
await t.quit();
