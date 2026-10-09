import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MINUTES,
  parseArgs,
  parseScenario,
  readsSkill,
  renderTable,
  type Scenario,
} from "../scripts/skills-eval-scenario";

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
