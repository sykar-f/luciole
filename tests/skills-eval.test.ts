import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AGENT_MATERIAL,
  baselineOf,
  CORE_PACKAGE,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MINUTES,
  diffSince,
  must,
  parseArgs,
  parseScenario,
  readsSkill,
  renderTable,
  run,
  runCheck,
  runInApp,
  runPass,
  splitBases,
  type Kill,
  type RunResult,
  type Scenario,
} from "../scripts/skills-eval-scenario";

const temp = await mkdtemp(join(tmpdir(), "luciole-skills-eval-test-"));
afterAll(() => rm(temp, { recursive: true, force: true }));

const evals = resolve(import.meta.dir, "../evals/skills");

test("every scenario of the repository parses", async () => {
  const skills = (await readdir(evals, { withFileTypes: true })).filter((e) => e.isDirectory());
  expect(skills.length).toBeGreaterThan(0);
  for (const { name: skill } of skills)
    // A scenario's fixtures sit beside it, in directories or as other files.
    for (const entry of await readdir(join(evals, skill), { withFileTypes: true }))
      if (entry.isFile() && entry.name.endsWith(".md"))
        parseScenario(
          `${skill}/${entry.name}`,
          await readFile(join(evals, skill, entry.name), "utf8"),
        );
});

test("a scenario holds its prompt, checks and options", () => {
  const scenario = parseScenario(
    "luciole-app/x",
    [
      "---",
      "expect-skill: luciole-app",
      "checks:",
      "  - run: bun run verify",
      "  - exists: app/about/page.tsx",
      "  - absent: app/old.tsx",
      "  - match: { file: a.ts, pattern: 'x+' }",
      "  - no-match: { file: a.ts, pattern: y }",
      "---",
      "",
      "Do the thing.",
      "",
    ].join("\n"),
  );
  expect(scenario).toEqual({
    name: "luciole-app/x",
    prompt: "Do the thing.",
    expectSkill: "luciole-app",
    timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
    checks: [
      { run: "bun run verify" },
      { exists: "app/about/page.tsx" },
      { absent: "app/old.tsx" },
      { match: { file: "a.ts", pattern: "x+" } },
      { "no-match": { file: "a.ts", pattern: "y" } },
    ],
  });
});

test("a scenario may plant the app's state with a setup, on several lines", () => {
  const scenario = parseScenario(
    "luciole-upgrade/x",
    [
      "---",
      "setup: |",
      "  echo one > one.txt",
      '  cp "$SCENARIO_DIR/fixtures/x.tsx" app/x.tsx',
      "checks:",
      "  - exists: one.txt",
      "---",
      "Do it.",
    ].join("\n"),
  );
  expect(scenario.setup).toBe('echo one > one.txt\ncp "$SCENARIO_DIR/fixtures/x.tsx" app/x.tsx\n');
  expect(parseScenario("luciole-app/x", "---\nchecks:\n  - exists: a\n---\nDo it.").setup).toBe(
    undefined,
  );
});

test.each([
  ["no frontmatter", "Do it.", "no YAML frontmatter"],
  ["no checks", "---\nexpect-skill: luciole-app\n---\nDo it.", "checks"],
  ["an unknown check", "---\nchecks:\n  - grep: x\n---\nDo it.", "checks"],
  ["an unknown field", "---\nmodel: o3\nchecks:\n  - exists: a\n---\nDo it.", "model"],
  [
    "an unknown field beside setup",
    "---\nsetup: x\nmodel: o3\nchecks: [{ exists: a }]\n---\nDo it.",
    "model",
  ],
  ["an empty setup", "---\nsetup: ''\nchecks:\n  - exists: a\n---\nDo it.", "setup"],
  ["an empty prompt", "---\nchecks:\n  - exists: a\n---\n\n", "prompt"],
  ["a bad regex", "---\nchecks:\n  - match: { file: a, pattern: '(' }\n---\nDo it.", "pattern"],
])("a scenario with %s is refused", (_, text, message) => {
  expect(() => parseScenario("luciole-app/x", text)).toThrow(message);
});

test("the command line: skill, scenarios, runs and model", () => {
  expect(parseArgs(["luciole-app"])).toEqual({
    skill: "luciole-app",
    scenarios: [],
    runs: 1,
    model: DEFAULT_MODEL,
  });
  expect(parseArgs(["luciole-app", "a.md", "b", "--runs", "3", "--model", "m"])).toEqual({
    skill: "luciole-app",
    scenarios: ["a", "b"],
    runs: 3,
    model: "m",
  });
  expect(() => parseArgs([])).toThrow("name a skill");
  expect(() => parseArgs(["s", "--runs", "0"])).toThrow("positive integer");
  expect(() => parseArgs(["s", "--runs"])).toThrow("needs a value");
  expect(() => parseArgs(["s", "--fast"])).toThrow("unknown option");
});

const event = (item: Record<string, unknown>) => JSON.stringify({ type: "item.completed", item });

test("a skill counts as read when a command the agent ran names its SKILL.md", () => {
  const read = event({
    type: "command_execution",
    command: "/bin/zsh -lc 'cat .agents/skills/luciole-app/SKILL.md'",
  });
  expect(readsSkill(read, "luciole-app")).toBe(true);
  expect(readsSkill(read, "luciole-test")).toBe(false);
  // A message that names the file is not a read; nor is a line that is not an event.
  const said = event({ type: "agent_message", text: "see .agents/skills/luciole-app/SKILL.md" });
  expect(readsSkill([said, "cat luciole-app/SKILL.md"].join("\n"), "luciole-app")).toBe(false);
});

test("the table: one row per run, a column per check, and the legend", () => {
  const scenario: Scenario = {
    name: "luciole-app/about",
    prompt: "p",
    checks: [{ exists: "a" }, { run: "bun run verify" }],
    expectSkill: "luciole-app",
    timeoutMinutes: 1,
  };
  const table = renderTable(
    [
      {
        scenario: scenario.name,
        arm: "without",
        run: 1,
        checks: [true, false],
        skillRead: false,
        agent: "ok",
        seconds: 61.4,
      },
      {
        scenario: scenario.name,
        arm: "with",
        run: 1,
        checks: [true, true],
        skillRead: true,
        agent: "timeout",
        seconds: 90,
      },
    ],
    [scenario],
  );
  expect(table).toBe(
    [
      "| scenario          | arm     | run | c1   | c2   | skill read | agent   | duration |",
      "|-------------------|---------|-----|------|------|------------|---------|----------|",
      "| luciole-app/about | without | 1   | pass | FAIL | no         | ok      | 61s      |",
      "| luciole-app/about | with    | 1   | pass | pass | yes        | timeout | 90s      |",
      "",
      "Checks:",
      "  luciole-app/about c1: exists a",
      "  luciole-app/about c2: run bun run verify",
    ].join("\n"),
  );
});

/** Whether the process `pid` exists. */
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A stand-in agent: it starts a child that would outlive it, prints the child's pid, waits. */
const SPAWNS_CHILD = ["sh", "-c", "sleep 60 & echo $!; wait"];
const LEAVES_CHILD = ["sh", "-c", "sleep 60 & echo $!"];
const pidOf = (output: string) => Number(output.trim().split("\n")[0]);

test("a timeout ends the agent's whole process group", async () => {
  const result = await run(SPAWNS_CHILD, temp, { timeoutMs: 2000 });
  expect(result.timedOut).toBe(true);
  const child = pidOf(result.output);
  expect(child).toBeGreaterThan(0);
  expect(alive(child)).toBe(false);
});

test("a child the agent leaves behind ends with the run", async () => {
  const result = await run(LEAVES_CHILD, temp, { timeoutMs: 10_000 });
  expect(result).toMatchObject({ code: 0, timedOut: false });
  expect(alive(pidOf(result.output))).toBe(false);
});

test("each check kind passes and fails as its scenario says", async () => {
  const app = await mkdtemp(join(temp, "app-"));
  await writeFile(join(app, "page.tsx"), "export const title = 'About Notes';\n");
  const cases: [Parameters<typeof runCheck>[0], boolean][] = [
    [{ run: "exit 0" }, true],
    [{ run: "exit 1" }, false],
    [{ exists: "page.tsx" }, true],
    [{ exists: "missing.tsx" }, false],
    [{ absent: "missing.tsx" }, true],
    [{ absent: "page.tsx" }, false],
    [{ match: { file: "page.tsx", pattern: "About Notes" } }, true],
    [{ match: { file: "page.tsx", pattern: "^Nope" } }, false],
    [{ "no-match": { file: "page.tsx", pattern: "^Nope" } }, true],
    [{ "no-match": { file: "page.tsx", pattern: "About" } }, false],
    [{ match: { file: "missing.tsx", pattern: "x" } }, false],
    [{ "no-match": { file: "missing.tsx", pattern: "x" } }, false],
  ];
  for (const [check, passed] of cases)
    expect({ check, passed: (await runCheck(check, app)).passed }).toEqual({ check, passed });
  expect((await runCheck({ run: "echo out; exit 3" }, app)).log).toBe("exit 3\nout\n");
  expect((await runCheck({ match: { file: "missing.tsx", pattern: "x" } }, app)).log).toBe(
    "missing.tsx does not exist",
  );
});

test("a check command that runs out of time fails", async () => {
  const app = await mkdtemp(join(temp, "app-"));
  const result = await runCheck({ run: "sleep 60" }, app, { timeoutMs: 200 });
  expect(result.passed).toBe(false);
  expect(result.log).toStartWith("timed out");
});

test("the diff holds what the agent committed as well as what it left", async () => {
  const app = join(temp, "repo");
  await mkdir(app);
  const git = (...args: string[]) =>
    must(["git", "-c", "user.name=t", "-c", "user.email=t@t.invalid", ...args], app);
  await writeFile(join(app, "a.txt"), "a\n");
  await git("init", "-q");
  await git("add", "-A");
  await git("commit", "-q", "-m", "baseline");
  const baseline = await baselineOf(app);

  await writeFile(join(app, "committed.txt"), "committed\n");
  await git("add", "-A");
  await git("commit", "-q", "-m", "the agent's commit");
  await writeFile(join(app, "a.txt"), "a changed\n");
  await writeFile(join(app, "untracked.txt"), "untracked\n");

  const diff = await diffSince(app, baseline);
  expect(diff).toContain("+committed");
  expect(diff).toContain("+a changed");
  expect(diff).toContain("+untracked");
});

/** A fresh app copy as a run finds it: a git repository with one baseline commit. */
async function appCopy() {
  const out = await mkdtemp(join(temp, "run-"));
  const app = join(out, "app");
  await mkdir(app);
  await writeFile(join(app, "a.txt"), "a\n");
  await must(["git", "init", "-q"], app);
  await must(["git", "add", "-A"], app);
  await must(
    ["git", "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "-m", "base"],
    app,
  );
  return { out, app };
}

/** A scenario directory holding a fixture file, as a setup finds it in `$SCENARIO_DIR`. */
async function scenarioDir() {
  const directory = await mkdtemp(join(temp, "scenarios-"));
  await mkdir(join(directory, "fixtures"));
  await writeFile(join(directory, "fixtures", "planted.txt"), "from the fixture\n");
  return directory;
}

/** A stand-in agent: it writes one file and says so on stdout. */
const WRITES_FILE = ["sh", "-c", "echo agent > agent.txt; echo wrote agent.txt"];

const withSetup = (setup: string): Scenario => ({
  name: "luciole-x/planted",
  prompt: "p",
  setup,
  checks: [{ exists: "planted.txt" }, { exists: "agent.txt" }],
  timeoutMinutes: 1,
});

test("a setup's change is in the baseline, and the diff holds only the agent's", async () => {
  const { out, app } = await appCopy();
  const result = await runInApp({
    scenario: withSetup('cp "$SCENARIO_DIR/fixtures/planted.txt" planted.txt\necho a set > a.txt'),
    scenarioDir: await scenarioDir(),
    app,
    out,
    agent: WRITES_FILE,
  });
  expect(result).toMatchObject({ agent: "ok", checks: [true, true] });
  expect(await readFile(join(app, "planted.txt"), "utf8")).toBe("from the fixture\n");
  const diff = await readFile(join(out, "diff.patch"), "utf8");
  expect(diff).toContain("+agent");
  expect(diff).not.toContain("planted");
  expect(diff).not.toContain("a set");
  expect(await readFile(join(out, "setup.log"), "utf8")).toBe("exit 0\n");
  expect(await readFile(join(out, "transcript.jsonl"), "utf8")).toBe("wrote agent.txt\n");
});

test("the setup sees the scenario's directory as $SCENARIO_DIR", async () => {
  const { out, app } = await appCopy();
  const directory = await scenarioDir();
  await runInApp({
    scenario: withSetup('printf %s "$SCENARIO_DIR" > planted.txt'),
    scenarioDir: directory,
    app,
    out,
    agent: WRITES_FILE,
  });
  expect(await readFile(join(app, "planted.txt"), "utf8")).toBe(directory);
});

test("a failing setup starts no agent and no check, and the report says so", async () => {
  const { out, app } = await appCopy();
  const scenario = withSetup("echo boom; exit 3");
  const result = await runInApp({
    scenario,
    scenarioDir: await scenarioDir(),
    app,
    out,
    agent: WRITES_FILE,
  });
  expect(result).toEqual({ checks: [], agent: "setup failed", seconds: 0 });
  expect(await Bun.file(join(app, "agent.txt")).exists()).toBe(false);
  expect(await readFile(join(out, "setup.log"), "utf8")).toBe("exit 3\nboom\n");
  for (const file of ["transcript.jsonl", "diff.patch", "checks.log"])
    expect({ file, exists: await Bun.file(join(out, file)).exists() }).toEqual({
      file,
      exists: false,
    });
  const table = renderTable(
    [{ scenario: scenario.name, arm: "with", run: 1, ...result }],
    [scenario],
  );
  expect(table.split("\n")[2]).toBe(
    "| luciole-x/planted | with | 1   |    |    | -          | setup failed | 0s       |",
  );
});

test("a scenario without setup runs the agent on the app as copied", async () => {
  const { out, app } = await appCopy();
  const { setup: _, ...scenario } = withSetup("unused");
  const result = await runInApp({ scenario, scenarioDir: temp, app, out, agent: WRITES_FILE });
  expect(result).toMatchObject({ agent: "ok", checks: [false, true] });
  expect(await Bun.file(join(out, "setup.log")).exists()).toBe(false);
});

const eperm = () => Object.assign(new Error("kill EPERM"), { code: "EPERM" });

test("a refused group signal still ends the run when the group is gone", async () => {
  const { out, app } = await appCopy();
  // The signal is delivered, but the system still answers EPERM, as macOS may.
  const kill: Kill = (pid, signal) => {
    process.kill(pid, signal);
    throw eperm();
  };
  const { setup: _, ...scenario } = withSetup("unused");
  const result = await runInApp({
    scenario,
    scenarioDir: temp,
    app,
    out,
    agent: LEAVES_CHILD,
    cleanup: { kill },
  });
  expect(result).toMatchObject({ agent: "ok", left: undefined });
  expect(alive(pidOf(await readFile(join(out, "transcript.jsonl"), "utf8")))).toBe(false);
});

test("a member no signal can end is reported, and the run completes", async () => {
  const { out, app } = await appCopy();
  const kill: Kill = () => {
    throw eperm();
  };
  const scenario: Scenario = {
    name: "luciole-x/stuck",
    prompt: "p",
    checks: [{ exists: "a.txt" }],
    timeoutMinutes: 1,
  };
  const result = await runInApp({
    scenario,
    scenarioDir: temp,
    app,
    out,
    agent: LEAVES_CHILD,
    cleanup: { kill, goneMs: 200 },
  });
  const child = pidOf(await readFile(join(out, "transcript.jsonl"), "utf8"));
  try {
    expect(result).toMatchObject({ agent: "ok", left: 1, checks: [true] });
    const table = renderTable(
      [{ scenario: scenario.name, arm: "without", run: 1, ...result }],
      [scenario],
    );
    expect(table).toContain("| ok, cleanup: 1 left |");
  } finally {
    process.kill(child, "SIGKILL");
  }
});

test("the report keeps the finished rows when a later run fails", async () => {
  const report = join(await mkdtemp(join(temp, "report-")), "report.md");
  const scenario: Scenario = {
    name: "luciole-x/pass",
    prompt: "p",
    checks: [{ exists: "a" }],
    timeoutMinutes: 1,
  };
  const row = (run: number): RunResult => ({
    scenario: scenario.name,
    arm: "without",
    run,
    checks: [true],
    agent: "ok",
    seconds: 1,
  });
  const pass = runPass(
    [1, 2, 3],
    async (n) => {
      if (n === 3) throw new Error("the third run crashed");
      return row(n);
    },
    { scenarios: [scenario], report },
  );
  const failure = await pass.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(String(failure)).toContain("the third run crashed");
  const lines = (await readFile(report, "utf8")).split("\n");
  expect(lines.slice(2, 5)).toEqual([
    "| luciole-x/pass | without | 1   | pass | -          | ok    | 1s       |",
    "| luciole-x/pass | without | 2   | pass | -          | ok    | 1s       |",
    "",
  ]);
});

test("the without base keeps the package's docs but none of its agent material", async () => {
  const without = join(temp, "split", "without");
  const withMaterial = join(temp, "split", "with");
  const core = (app: string) => join(app, CORE_PACKAGE);
  await mkdir(join(core(without), "skills/luciole-app"), { recursive: true });
  await mkdir(join(core(without), "docs"), { recursive: true });
  await writeFile(join(core(without), "skills/luciole-app/SKILL.md"), "skill\n");
  await writeFile(join(core(without), "agents-block.md"), "block\n");
  await writeFile(join(core(without), "docs/index.md"), "docs\n");
  const installedFrom: string[][] = [];
  await splitBases({
    without,
    with: withMaterial,
    copy: async (from, to) => {
      await must(["cp", "-R", from, to], temp);
    },
    // A stand-in for `luciole skills install`: what the package offers it when it runs.
    install: async (app) => {
      installedFrom.push(await readdir(core(app)));
    },
  });
  expect(AGENT_MATERIAL).toEqual(["skills", "agents-block.md"]);
  expect(installedFrom.map((entries) => entries.toSorted())).toEqual([
    ["agents-block.md", "docs", "skills"],
  ]);
  expect((await readdir(core(without))).toSorted()).toEqual(["docs"]);
  expect((await readdir(core(withMaterial))).toSorted()).toEqual([
    "agents-block.md",
    "docs",
    "skills",
  ]);
  expect(await readFile(join(core(withMaterial), "skills/luciole-app/SKILL.md"), "utf8")).toBe(
    "skill\n",
  );
});
