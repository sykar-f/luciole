import { z } from "zod";

/**
 * The pure parts of `scripts/skills-eval.ts`: the scenario format, the command line, whether a
 * transcript shows an agent reading a skill, and the report's table. The format is documented
 * in evals/skills/README.md.
 */

export const DEFAULT_MODEL = "gpt-6-luna";
export const DEFAULT_RUNS = 1;
export const DEFAULT_TIMEOUT_MINUTES = 15;

const Check = z.union([
  z.strictObject({ run: z.string().min(1) }),
  z.strictObject({ exists: z.string().min(1) }),
  z.strictObject({ absent: z.string().min(1) }),
  z.strictObject({ match: z.strictObject({ file: z.string().min(1), pattern: z.string() }) }),
  z.strictObject({ "no-match": z.strictObject({ file: z.string().min(1), pattern: z.string() }) }),
]);
export type Check = z.infer<typeof Check>;

const Frontmatter = z.strictObject({
  "expect-skill": z
    .string()
    .regex(/^luciole-[a-z0-9-]+$/)
    .optional(),
  "timeout-minutes": z.number().positive().optional(),
  checks: z.array(Check).min(1),
});

export interface Scenario {
  name: string;
  prompt: string;
  checks: readonly Check[];
  expectSkill?: string;
  timeoutMinutes: number;
}

/** A scenario file's text, read as `name`: its prompt, checks and options, or a thrown error. */
export function parseScenario(name: string, text: string): Scenario {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${name}: no YAML frontmatter between --- lines`);
  const parsed = Frontmatter.safeParse(Bun.YAML.parse(match[1] ?? ""));
  if (!parsed.success) throw new Error(`${name}: ${z.prettifyError(parsed.error)}`);
  const prompt = (match[2] ?? "").trim();
  if (!prompt) throw new Error(`${name}: the prompt (the text after the frontmatter) is empty`);
  for (const check of parsed.data.checks) {
    const pattern = "match" in check ? check.match : "no-match" in check ? check["no-match"] : null;
    if (!pattern) continue;
    try {
      new RegExp(pattern.pattern);
    } catch (error: unknown) {
      throw new Error(`${name}: invalid pattern ${pattern.pattern}: ${String(error)}`, {
        cause: error,
      });
    }
  }
  return {
    name,
    prompt,
    checks: parsed.data.checks,
    expectSkill: parsed.data["expect-skill"],
    timeoutMinutes: parsed.data["timeout-minutes"] ?? DEFAULT_TIMEOUT_MINUTES,
  };
}

/** A check in a few words, for the table and the logs. */
export function describeCheck(check: Check): string {
  if ("run" in check) return `run ${check.run}`;
  if ("exists" in check) return `exists ${check.exists}`;
  if ("absent" in check) return `absent ${check.absent}`;
  if ("match" in check) return `match ${check.match.file} /${check.match.pattern}/`;
  return `no-match ${check["no-match"].file} /${check["no-match"].pattern}/`;
}

export interface Args {
  skill: string;
  scenarios: readonly string[];
  runs: number;
  model: string;
}

export const USAGE =
  "Usage: bun run skills:eval <skill> [<scenario>…] [--runs N] [--model M]\n" +
  `  --runs   runs per scenario and arm (default ${DEFAULT_RUNS})\n` +
  `  --model  the Codex model (default ${DEFAULT_MODEL})`;

/** The command line's arguments, or a thrown error that the usage follows. */
export function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  let runs = DEFAULT_RUNS;
  let model = DEFAULT_MODEL;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--runs") {
      const raw = value();
      runs = Number(raw);
      if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs ${raw}: a positive integer`);
    } else if (arg === "--model") model = value();
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else positional.push(arg.replace(/\.md$/, ""));
  }
  const [skill, ...scenarios] = positional;
  if (!skill) throw new Error("name a skill");
  return { skill, scenarios, runs, model };
}

// The events of `codex exec --json` that carry a shell command the agent ran.
const CommandEvent = z.looseObject({
  item: z.looseObject({ type: z.literal("command_execution"), command: z.string() }),
});

/**
 * Whether a `codex exec --json` transcript shows the agent reading `skill`'s SKILL.md: a
 * command it ran names the file. The skill's description, which the agent sees without reading
 * anything, does not count.
 */
export function readsSkill(transcript: string, skill: string): boolean {
  const path = `${skill}/SKILL.md`;
  return transcript.split("\n").some((line) => {
    if (!line.includes(path)) return false;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return false;
    }
    const parsed = CommandEvent.safeParse(event);
    return parsed.success && parsed.data.item.command.includes(path);
  });
}

export type Arm = "without" | "with";

export interface RunResult {
  scenario: string;
  arm: Arm;
  run: number;
  /** One per check, in the scenario's order. */
  checks: readonly boolean[];
  /** Absent when the scenario expects no skill. */
  skillRead?: boolean;
  /** Whether the agent ran out of time or exited non-zero. */
  agent: "ok" | "timeout" | `exit ${number}`;
  seconds: number;
}

/** The report: one row per scenario, arm and run, then the legend of the check columns. */
export function renderTable(results: readonly RunResult[], scenarios: readonly Scenario[]) {
  const width = Math.max(0, ...scenarios.map((s) => s.checks.length));
  const header = [
    "scenario",
    "arm",
    "run",
    ...Array.from({ length: width }, (_, i) => `c${i + 1}`),
    "skill read",
    "agent",
    "duration",
  ];
  const rows = results.map((result) => [
    result.scenario,
    result.arm,
    String(result.run),
    ...Array.from({ length: width }, (_, i) => {
      const passed = result.checks[i];
      return passed === undefined ? "" : passed ? "pass" : "FAIL";
    }),
    result.skillRead === undefined ? "-" : result.skillRead ? "yes" : "no",
    result.agent,
    `${Math.round(result.seconds)}s`,
  ]);
  const widths = header.map((cell, i) =>
    Math.max(cell.length, ...rows.map((row) => (row[i] ?? "").length)),
  );
  const line = (cells: readonly string[]) =>
    `| ${cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join(" | ")} |`;
  const legend = scenarios.flatMap((scenario) =>
    scenario.checks.map((check, i) => `  ${scenario.name} c${i + 1}: ${describeCheck(check)}`),
  );
  return [
    line(header),
    `|${widths.map((w) => "-".repeat(w + 2)).join("|")}|`,
    ...rows.map(line),
    "",
    "Checks:",
    ...legend,
  ].join("\n");
}
