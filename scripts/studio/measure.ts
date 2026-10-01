/**
 * Step 6 of examples/studio/DESIGN.md (plan C5b): how often a real harness's app builds and
 * runs, at its first attempt and after studio's automatic corrections. Each prompt of the
 * generator's scenarios goes to a fresh project, through the same harness options,
 * policy and validation as studio (server/harness.ts, server/validate.ts).
 *
 * Every real prompt spends the user's quota: a real harness
 * runs only with --accept-quota, after the count of prompts it may send is printed. The
 * scripted generator (--harness fake) runs freely: it checks this script itself.
 *
 *   bun scripts/studio/measure.ts --harness fake
 *   bun scripts/studio/measure.ts --harness claude --accept-quota [--only todo,greeting]
 *        [--fixes 2] [--record DIR] [--out results.json]
 *
 * Render failures are reported by a preview Client, which this script does not open:
 * they count as passed here, and the report says so.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import type { HarnessId, Item, Usage } from "../../packages/harness/src/model";
import { HarnessSession } from "../../packages/harness/src/session";
import type { Diagnostic, Stage } from "../../examples/studio/components/model";
import { STUDIO_PREFIX } from "../../examples/studio/server/generator";
import { create, pick, START } from "../../examples/studio/server/harness";
import { policy } from "../../examples/studio/server/policy";
import { isolationProblem, PreviewServers } from "../../examples/studio/server/preview";
import { Project } from "../../examples/studio/server/project";
import { SCENARIOS, startingPoint, type Scenario } from "../../examples/studio/server/scenarios";
import { prepare } from "../../examples/studio/server/validate";

const MAX_FIXES = 5;
const DEFAULT_FIXES = 2;
const MINUTE_MS = 60_000;
const TURN_MINUTES = 10;
const Options = z.object({
  harness: z.enum(["claude", "fake"]),
  "accept-quota": z.boolean().default(false),
  only: z.string().optional(),
  fixes: z.coerce.number().int().min(0).max(MAX_FIXES).default(DEFAULT_FIXES),
  record: z.string().optional(),
  out: z.string().optional(),
});
const { values } = parseArgs({
  options: {
    harness: { type: "string" },
    "accept-quota": { type: "boolean" },
    only: { type: "string" },
    fixes: { type: "string" },
    record: { type: "string" },
    out: { type: "string" },
  },
  strict: true,
});
const options = Options.parse(values);
const harness: HarnessId = options.harness;
const wanted = options.only?.split(",").map((s) => s.trim());
const scenarios = SCENARIOS.filter((s) => !wanted || wanted.includes(s.name));
const turnsAtMost = scenarios.length * (1 + options.fixes);
if (harness !== "fake" && !options["accept-quota"]) {
  console.error(
    `${harness} would receive up to ${turnsAtMost} prompts (${scenarios.length} scenarios, ${options.fixes} corrections each), on your quota.\n` +
      "Nothing was sent. Run again with --accept-quota to measure.",
  );
  process.exit(2);
}
const TURN_TIMEOUT_MS = TURN_MINUTES * MINUTE_MS;

type Attempt = { stage: Stage | "ok"; diagnostics: Diagnostic[]; ms: number };
type Run = {
  scenario: string;
  prompt: string;
  attempts: Attempt[];
  /** What the harness reported: model, cost and tokens of the whole run. */
  model?: string;
  usage: Usage;
  items?: readonly Item[];
};

/**
 * One prompt in a fresh project (with the files of the scenario it continues), then
 * studio's corrections, as studio would send them.
 */
async function measure(scenario: Scenario): Promise<Omit<Run, "scenario">> {
  const { prompt } = scenario;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "studio-measure-")));
  const project = await Project.open(join(root, "app"));
  const start = Object.entries(startingPoint(scenario));
  for (const [path, content] of start) {
    const file = join(project.directory, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  if (start.length) await project.commit(scenario.after ?? "start");
  const servers = new PreviewServers(project, isolationProblem("sandbox") ? "process" : "sandbox");
  let ended: (() => void) | undefined;
  const session = new HarnessSession({
    harness,
    cwd: project.directory,
    mode: "ask",
    create,
    pick,
    start: START,
    policy,
    onTurnCompleted: () => ended?.(),
  });
  const turn = (text: string) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the turn took too long")), TURN_TIMEOUT_MS);
      ended = () => {
        clearTimeout(timer);
        resolve();
      };
      void session.send(text).then((result) => {
        if (!result.ok) {
          clearTimeout(timer);
          reject(new Error(result.error));
        }
      });
    });
  const attempts: Attempt[] = [];
  try {
    await session.start();
    let text = prompt;
    for (let revision = 1; revision <= 1 + options.fixes; revision++) {
      const started = performance.now();
      await turn(text);
      const changes = await project.changes();
      changes.delete("app/routeTree.gen.ts");
      const prepared = await prepare(project, servers, changes);
      let attempt: Attempt;
      if (!prepared.ok)
        attempt = { stage: prepared.stage, diagnostics: prepared.diagnostics, ms: 0 };
      else {
        await project.commit(`r${revision}`);
        try {
          await servers.start(revision, prepared.output);
          const types = await servers.types();
          attempt = types.length
            ? { stage: "types", diagnostics: types, ms: 0 }
            : { stage: "ok", diagnostics: [], ms: 0 };
        } catch (error: unknown) {
          attempt = {
            stage: "server",
            diagnostics: [{ message: error instanceof Error ? error.message : String(error) }],
            ms: 0,
          };
        }
      }
      attempt.ms = Math.round(performance.now() - started);
      attempts.push(attempt);
      if (attempt.stage === "ok") break;
      text = `${STUDIO_PREFIX} The ${attempt.stage} stage failed. Fix it, changing only what is needed:\n${attempt.diagnostics
        .map((d) => `- ${d.file ? `${d.file}${d.line ? `:${d.line}` : ""}: ` : ""}${d.message}`)
        .join("\n")}`;
    }
    const { items, usage, info } = session.snapshot();
    return { prompt, attempts, model: info.model, usage, items };
  } finally {
    session.close();
    await servers.stop();
    project.release();
    rmSync(root, { recursive: true, force: true });
  }
}

const runs: Run[] = [];
for (const scenario of scenarios) {
  const run = { scenario: scenario.name, ...(await measure(scenario)) };
  runs.push(run);
  const last = run.attempts.at(-1);
  console.log(
    `${scenario.name}: ${run.attempts.map((a) => a.stage).join(" → ")}${last?.stage === "ok" ? "" : " (not fixed)"}`,
  );
  if (options.record) {
    mkdirSync(options.record, { recursive: true });
    writeFileSync(
      join(options.record, `${harness}-${scenario.name}.json`),
      JSON.stringify(run, null, 2),
    );
  }
}
const firstOk = runs.filter((r) => r.attempts[0]?.stage === "ok").length;
const finalOk = runs.filter((r) => r.attempts.at(-1)?.stage === "ok").length;
const summary = {
  date: new Date().toISOString(),
  harness,
  scenarios: runs.length,
  passedAtFirstAttempt: firstOk,
  passedAfterCorrections: finalOk,
  turns: runs.reduce((n, r) => n + r.attempts.length, 0),
  minutes: Math.round(
    runs.reduce((n, r) => n + r.attempts.reduce((m, a) => m + a.ms, 0), 0) / MINUTE_MS,
  ),
  // Only what the harness reports (Claude Code gives a cost).
  costUsd: runs.reduce((n, r) => n + (r.usage.costUsd ?? 0), 0),
  fixesAllowed: options.fixes,
  note: "render failures need a preview Client and are not measured here",
  runs: runs.map(({ items: _items, ...run }) => run),
};
console.log(
  `${harness}: ${firstOk}/${runs.length} at the first attempt, ${finalOk}/${runs.length} after up to ${options.fixes} corrections`,
);
if (options.out) writeFileSync(options.out, JSON.stringify(summary, null, 2) + "\n");
