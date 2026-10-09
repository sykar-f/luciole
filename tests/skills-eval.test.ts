import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  baselineOf,
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
  type Scenario,
} from "../scripts/skills-eval-scenario";

const temp = await mkdtemp(join(tmpdir(), "luciole-skills-eval-test-"));
afterAll(() => rm(temp, { recursive: true, force: true }));

const evals = resolve(import.meta.dir, "../evals/skills");

test("every scenario of the repository parses", async () => {
  const skills = (await readdir(evals, { withFileTypes: true })).filter((e) => e.isDirectory());
  expect(skills.length).toBeGreaterThan(0);
  for (const { name: skill } of skills)
    for (const file of await readdir(join(evals, skill)))
      parseScenario(`${skill}/${file}`, await readFile(join(evals, skill, file), "utf8"));
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

test.each([
  ["no frontmatter", "Do it.", "no YAML frontmatter"],
  ["no checks", "---\nexpect-skill: luciole-app\n---\nDo it.", "checks"],
  ["an unknown check", "---\nchecks:\n  - grep: x\n---\nDo it.", "checks"],
  ["an unknown field", "---\nmodel: o3\nchecks:\n  - exists: a\n---\nDo it.", "model"],
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
