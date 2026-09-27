/**
 * The generation loop without a model: each scripted attempt of corpus.ts is guarded,
 * written into a fresh copy of the template, validated (validate.tsx), and when it fails
 * the scripted correction follows, as a harness would after reading the diagnostics.
 * Measures which stage catches which fault, whether the diagnostic points at the fault,
 * and what each stage costs. Run from the repository root:
 *
 *   bun probes/studio-generate/probe.ts      # writes results.json next to it
 */
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CORPUS } from "./corpus";
import { guard } from "./guard";
import { STAGES, validate, type Outcome, type Stage } from "./validate";

const HERE = import.meta.dir;
const TEMPLATE = resolve(HERE, "../studio-preview/template");
const WORK = join(HERE, ".airtty-work");
// A diagnostic "points at" the fault when it names its file within this many lines.
const LINE_TOLERANCE = 2;

const median = (values: readonly number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN;

type Attempt = { turn: number; outcome: Outcome };
const report: Record<string, unknown>[] = [];
const timings: Record<Stage, number[]> = { guard: [], build: [], types: [], render: [] };
let failures = 0;

for (const item of CORPUS) {
  const directory = join(WORK, item.name);
  // A fresh copy: files an earlier run wrote must not satisfy an import.
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  cpSync(TEMPLATE, directory, { recursive: true });
  const attempts: Attempt[] = [];
  for (const [index, turn] of item.turns.entries()) {
    const changes = new Map(Object.entries(turn));
    // Refused changes never reach the workspace.
    if (guard(changes).length === 0)
      for (const [file, content] of changes) {
        mkdirSync(dirname(join(directory, file)), { recursive: true });
        writeFileSync(join(directory, file), content);
      }
    const outcome = await validate(directory, changes);
    for (const stage of STAGES) {
      const spent = outcome.timings[stage];
      if (spent !== undefined) timings[stage].push(spent);
    }
    attempts.push({ turn: index, outcome });
    if (outcome.result === "ok") break;
  }
  const first = attempts[0]?.outcome;
  const last = attempts.at(-1)?.outcome;
  const pointed = item.fault
    ? (first?.diagnostics.some(
        (d) =>
          d.file === item.fault?.file &&
          d.line !== undefined &&
          Math.abs(d.line - (item.fault?.line ?? 0)) <= LINE_TOLERANCE,
      ) ?? false)
    : undefined;
  const caughtAsExpected = first?.result === item.expected;
  const repaired = last?.result === "ok";
  if (!caughtAsExpected || !repaired) failures++;
  const line = {
    name: item.name,
    prompt: item.prompt,
    expected: item.expected,
    caughtBy: first?.result,
    caughtAsExpected,
    pointsAtFault: pointed,
    repairedAfterTurns: repaired ? attempts.length : null,
    diagnostics: first?.diagnostics,
    timings: attempts.map((a) => a.outcome.timings),
  };
  report.push(line);
  console.log(
    `${caughtAsExpected && repaired ? "ok  " : "FAIL"} ${item.name}: caught by ${first?.result} (expected ${item.expected})` +
      `${pointed === undefined ? "" : `, points at fault: ${pointed}`}, repaired: ${repaired}`,
  );
  for (const d of first?.diagnostics ?? [])
    console.log(`       ${d.file ?? ""}${d.line ? `:${d.line}` : ""} ${d.message}`);
}

const summary = Object.fromEntries(
  STAGES.map((stage) => [stage, { medianMs: median(timings[stage]), runs: timings[stage].length }]),
);
console.log(summary);
writeFileSync(
  join(HERE, "results.json"),
  JSON.stringify(
    {
      date: new Date().toISOString(),
      platform: `${process.platform} ${process.arch}`,
      bun: Bun.version,
      stages: summary,
      cases: report,
    },
    null,
    2,
  ) + "\n",
);
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
