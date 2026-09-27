/**
 * Every scenario of studio's scripted generator against the real validation: the guard,
 * a signed build, the app's Server (confined where this system can), the type check.
 * Its first attempt fails at the stage it is written to fail at, with a diagnostic that
 * names the file (and the line, when the stage knows it); the correction that follows
 * passes. Render failures are the preview's to report (tests/studio.test.tsx): here
 * those attempts pass every stage before it.
 */
import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Diagnostic, Stage } from "../examples/studio/components/model";
import {
  isolationProblem,
  PreviewServers,
  type PreviewMode,
} from "../examples/studio/server/preview";
import { Project } from "../examples/studio/server/project";
import { SCENARIOS, type Scenario, type Turn } from "../examples/studio/server/scenarios";
import { prepare } from "../examples/studio/server/validate";

const MODE: PreviewMode = isolationProblem("sandbox") ? "process" : "sandbox";
const SCENARIO_TIMEOUT_MS = 90_000;

function write(project: Project, turn: Turn) {
  for (const [path, content] of Object.entries(turn)) {
    const file = join(project.directory, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

/** The files of the scenario `scenario` continues, committed: where it starts from. */
function startFrom(project: Project, scenario: Scenario) {
  const before = SCENARIOS.find((s) => s.name === scenario.after);
  if (!scenario.after) return;
  if (!before?.turns[0]) throw new Error(`${scenario.name} continues an unknown scenario`);
  for (const draft of before.drafts ?? []) write(project, draft);
  write(project, before.turns[0]);
  project.commit(before.name);
}

/** The first stage a turn fails at, or `ok`, as studio would find it. */
async function validate(
  project: Project,
  servers: PreviewServers,
  revision: number,
): Promise<{ stage: Stage | "ok"; diagnostics: Diagnostic[] }> {
  const changes = project.changes();
  changes.delete("app/routeTree.gen.ts");
  const prepared = await prepare(project, servers, changes);
  if (!prepared.ok) return { stage: prepared.stage, diagnostics: prepared.diagnostics };
  project.commit(`r${revision}`);
  try {
    await servers.start(revision, prepared.output);
  } catch (error: unknown) {
    return {
      stage: "server",
      diagnostics: [{ message: error instanceof Error ? error.message : String(error) }],
    };
  }
  const types = await servers.types();
  return types.length ? { stage: "types", diagnostics: types } : { stage: "ok", diagnostics: [] };
}

for (const scenario of SCENARIOS)
  test(
    `scenario ${scenario.name}: caught at ${scenario.expected}, then corrected`,
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "studio-scenario-")));
      const project = Project.open(join(root, "app"));
      const servers = new PreviewServers(project, MODE);
      try {
        const [first, ...corrections] = scenario.turns;
        if (!first) throw new Error(`${scenario.name} has no turn`);
        startFrom(project, scenario);
        for (const draft of scenario.drafts ?? []) write(project, draft);
        write(project, first);
        const found = await validate(project, servers, 1);
        // Render failures show only when a Client draws the page.
        expect(found.stage).toBe(scenario.expected === "render" ? "ok" : scenario.expected);
        if (scenario.expected !== "ok" && scenario.expected !== "render") {
          expect(found.diagnostics.length).toBeGreaterThan(0);
          const changed = Object.keys(first);
          expect(found.diagnostics.some((d) => d.file && changed.includes(d.file))).toBe(true);
          if (scenario.expected === "build" || scenario.expected === "types")
            expect(found.diagnostics.some((d) => d.line !== undefined)).toBe(true);
        }
        if (!corrections.length) return;
        for (const turn of corrections) write(project, turn);
        expect(await validate(project, servers, 2)).toEqual({ stage: "ok", diagnostics: [] });
      } finally {
        await servers.stop();
        project.release();
        rmSync(root, { recursive: true, force: true });
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

for (const scenario of SCENARIOS.filter((s) => s.drafts?.length))
  test(
    `scenario ${scenario.name}: each of its writes builds, as the drafts studio shows`,
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "studio-drafts-")));
      const project = Project.open(join(root, "app"));
      const servers = new PreviewServers(project, MODE);
      try {
        startFrom(project, scenario);
        for (const draft of scenario.drafts ?? []) {
          write(project, draft);
          const changes = project.changes();
          changes.delete("app/routeTree.gen.ts");
          expect(await prepare(project, servers, changes)).toMatchObject({ ok: true });
        }
      } finally {
        await servers.stop();
        project.release();
        rmSync(root, { recursive: true, force: true });
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

test(
  "a refused turn is undone whole: no file is left importing what was refused",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "studio-refused-")));
    const project = Project.open(join(root, "app"));
    const servers = new PreviewServers(project, MODE);
    try {
      write(project, {
        "server/git.ts": `import { execSync } from "node:child_process";\nexport const branch = () => execSync("git branch").toString();\n`,
        "app/page.tsx": `import { branch } from "../server/git";\nexport default function Page() {\n  return <text>{branch()}</text>;\n}\n`,
      });
      const prepared = await prepare(project, servers, project.changes());
      expect(prepared.ok).toBe(false);
      expect(project.changes().size).toBe(0);
      // What remains builds: the last revision, untouched.
      const again = await prepare(project, servers, project.changes());
      expect(again.ok).toBe(true);
    } finally {
      await servers.stop();
      project.release();
      rmSync(root, { recursive: true, force: true });
    }
  },
  SCENARIO_TIMEOUT_MS,
);
