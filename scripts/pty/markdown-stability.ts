/**
 * Whether a streamed Markdown reply holds still, on a real PTY: coder on the scripted
 * harness streams its rich reply (`markdown`: titles, nested lists, code, tables, quotes)
 * word by word, then 3 characters at a time, while the screen is sampled every few ms.
 *
 * - An oscillation is a row that changes from A to B and back to A within 3 samples: text
 *   flashing between two forms, or the transcript jumping as a height shrinks and grows.
 * - A raw frame shows a Markdown marker (`**`, a backtick, `## `, `](`) the finished reply
 *   hides: the rich reply's final screen shows none.
 *
 * Fails above MARKDOWN_MAX_OSCILLATIONS (0) or MARKDOWN_MAX_RAW_FRAMES (0) raw frames per
 * run. For comparison, OpenTUI 0.5.12's `<markdown internalBlockMode="top-level">` gives
 * 0 and 19 oscillations, 62 and 282 raw frames.
 * MARKDOWN_FRAMES=<dir> writes the samples there as JSON.
 *
 *   bun scripts/pty/markdown-stability.ts claude|codex|pi|opencode
 *
 * runs once on that harness instead (spends a little quota; manual): the model is asked for
 * a short Markdown reply; only oscillations fail it, a code block may show backticks.
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { MARKDOWN_END } from "../../packages/harness/src/adapters/fake";
import { drive, Keys } from "./driver";
import { BUN, CLI, example, numberFromEnv, report, temporaryDirectory } from "./harness";

const BOOT_TIMEOUT_MS = 60_000;
const REPLY_TIMEOUT_MS = 180_000;
const SAMPLE_MS = 5;
// Samples kept after the last line shows: the switch to "finished" must not move anything.
const AFTER_MS = 1000;
// A row that comes back to what it showed within this many samples oscillated.
const WINDOW = 3;
// The input box and status line at the bottom are not the transcript.
const FOOTER_ROWS = 5;
const RAW = /\*\*|`|^\s*#{1,6} |\]\(|~~/;
const MAX_OSCILLATIONS = numberFromEnv("MARKDOWN_MAX_OSCILLATIONS", 0);
const MAX_RAW_FRAMES = numberFromEnv("MARKDOWN_MAX_RAW_FRAMES", 0);
const FRAMES = process.env.MARKDOWN_FRAMES;
const [harness = "fake"] = process.argv.slice(2);
const real = harness !== "fake";
// The last line the model writes: one the prompt does not quote, so the echo never ends a run.
const REAL_END = "DONE-DONE-DONE";
const REAL_PROMPT =
  "Without using any tool, reply in Markdown: a title, a paragraph with bold, italic and " +
  "inline code, a nested list, a short TypeScript code block and a 3-row table. End with " +
  "a line made of the word DONE three times, joined by dashes.";
const END = real ? REAL_END : MARKDOWN_END;
const RUNS: readonly (readonly [string, string])[] = real
  ? [[harness, REAL_PROMPT]]
  : [
      ["words", "markdown"],
      ["threeChars", "markdown chars"],
    ];

/** A fresh coder: sends `prompt`, samples the screen until the reply ends and a little after. */
async function sample(prompt: string) {
  using directory = temporaryDirectory("luciole-markdown-");
  const project = join(directory.path, "project");
  mkdirSync(project);
  await using t = await drive({
    command: [BUN, CLI, "dev", "--app", example("coder"), "--", "--harness", harness],
    cols: 100,
    rows: 30,
    cwd: project,
    env: { XDG_STATE_HOME: join(directory.path, "state"), CODER_FAKE_DELAY_MS: "8" },
    settle: 300,
  });
  await t.waitFor(/scripted demo is ready|is ready in/, { timeout: BOOT_TIMEOUT_MS });
  await t.type(prompt);
  await t.type(Keys.enter, 0);
  const frames: string[][] = [];
  const start = performance.now();
  let ended: number | undefined;
  while (ended === undefined || performance.now() - ended < AFTER_MS) {
    const lines = await t.lines();
    frames.push(lines);
    if (ended === undefined && lines.some((line) => line.includes(END))) ended = performance.now();
    assert.ok(performance.now() - start < REPLY_TIMEOUT_MS, `the reply to "${prompt}" never ended`);
    await Bun.sleep(SAMPLE_MS);
  }
  await t.quit();
  return frames;
}

function oscillations(frames: readonly (readonly string[])[]) {
  let count = 0;
  for (let i = 1; i < frames.length - WINDOW; i++) {
    const rows = (frames[i] ?? []).length - FOOTER_ROWS;
    for (let row = 1; row < rows; row++) {
      const before = frames[i - 1]?.[row]?.trimEnd() ?? "";
      const now = frames[i]?.[row]?.trimEnd() ?? "";
      if (before === now || !before) continue;
      for (let next = i + 1; next <= i + WINDOW; next++) {
        if (frames[next]?.[row]?.trimEnd() === before) {
          count++;
          break;
        }
      }
    }
  }
  return count;
}

const rawFrames = (frames: readonly (readonly string[])[]) =>
  frames.filter((lines) => lines.slice(0, -FOOTER_ROWS).some((line) => RAW.test(line))).length;

const results: Record<string, { frames: number; oscillations: number; rawFrames: number }> = {};
for (const [name, prompt] of RUNS) {
  const frames = await sample(prompt);
  if (FRAMES) {
    mkdirSync(FRAMES, { recursive: true });
    await Bun.write(join(FRAMES, `${name}.json`), JSON.stringify(frames));
  }
  results[name] = {
    frames: frames.length,
    oscillations: oscillations(frames),
    rawFrames: rawFrames(frames),
  };
}
report({ markdownStability: results });
for (const [name, result] of Object.entries(results)) {
  assert.ok(
    result.oscillations <= MAX_OSCILLATIONS,
    `${name}: ${result.oscillations} oscillations (at most ${MAX_OSCILLATIONS})`,
  );
  assert.ok(
    real || result.rawFrames <= MAX_RAW_FRAMES,
    `${name}: ${result.rawFrames} frames with raw markers (at most ${MAX_RAW_FRAMES})`,
  );
}
