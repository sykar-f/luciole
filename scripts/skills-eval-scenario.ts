import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * The parts of `scripts/skills-eval.ts` that run without Codex: the scenario format, the
 * command line, processes and their groups, the setup, the checks, the run's diff, one run in
 * an app copy with the agent's command given, whether a transcript shows an agent reading a
 * skill, and the report's table. The format is documented in
 * evals/skills/README.md.
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
  setup: z.string().min(1).optional(),
  checks: z.array(Check).min(1),
});

export interface Scenario {
  name: string;
  prompt: string;
  checks: readonly Check[];
  expectSkill?: string;
  timeoutMinutes: number;
  /** A shell command that plants the app's state before the baseline commit. */
  setup?: string;
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
    setup: parsed.data.setup,
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
  /** Whether the agent ran out of time or exited non-zero, or never started. */
  agent: "ok" | "timeout" | `exit ${number}` | "setup failed";
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

export interface Ran {
  code: number;
  output: string;
  timedOut: boolean;
}

/** How long a process group may take to disappear once killed. */
const GROUP_GONE_MS = 5000;
const GROUP_POLL_MS = 20;

/** Whether the process group `id` still has a member. */
function groupAlive(id: number) {
  try {
    process.kill(-id, 0);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

/**
 * Kills every process of the group `id` and waits until none is left. An agent starts servers,
 * watchers and test runners; none may outlive its run, hold its copy of the app, or keep a port.
 */
export async function endGroup(id: number) {
  try {
    process.kill(-id, "SIGKILL");
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
  const deadline = performance.now() + GROUP_GONE_MS;
  while (groupAlive(id)) {
    if (performance.now() > deadline) throw new Error(`process group ${id} survived SIGKILL`);
    await Bun.sleep(GROUP_POLL_MS);
  }
}

/**
 * Runs `cmd` with stdin closed, as the leader of its own process group: on timeout, and after
 * it exits, the whole group ends, children and grandchildren included.
 */
export async function run(
  cmd: readonly string[],
  cwd: string,
  options: { timeoutMs?: number; env?: Readonly<Record<string, string>> } = {},
): Promise<Ran> {
  const child = Bun.spawn([...cmd], {
    cwd,
    env: { ...process.env, ...options.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  // Read while it runs: a full pipe would stall it. A child that keeps the pipe open keeps
  // the read pending until the group ends below.
  const out = new Response(child.stdout).text();
  const err = new Response(child.stderr).text();
  let timedOut = false;
  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          endGroup(child.pid).catch(() => undefined);
        }, options.timeoutMs);
  const code = await child.exited;
  clearTimeout(timer);
  await endGroup(child.pid);
  return { code, output: (await out) + (await err), timedOut };
}

/** `run`, which must exit 0: its output, or a thrown error that holds it. */
export async function must(cmd: readonly string[], cwd: string) {
  const result = await run(cmd, cwd);
  if (result.code !== 0) throw new Error(`${cmd.join(" ")} failed in ${cwd}:\n${result.output}`);
  return result.output;
}

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;
/** How long one check command may run. */
const CHECK_TIMEOUT_MINUTES = 10;
export const CHECK_TIMEOUT_MS = CHECK_TIMEOUT_MINUTES * MS_PER_MINUTE;

/** Whether `check` holds in `app`, and what it saw. */
export async function runCheck(
  check: Check,
  app: string,
  options: { timeoutMs?: number } = {},
): Promise<{ passed: boolean; log: string }> {
  if ("run" in check) {
    const result = await run(["sh", "-c", check.run], app, {
      timeoutMs: options.timeoutMs ?? CHECK_TIMEOUT_MS,
    });
    const status = result.timedOut ? "timed out" : `exit ${result.code}`;
    return { passed: result.code === 0 && !result.timedOut, log: `${status}\n${result.output}` };
  }
  if ("exists" in check || "absent" in check) {
    const path = "exists" in check ? check.exists : check.absent;
    const found = await Bun.file(join(app, path)).exists();
    return { passed: "exists" in check ? found : !found, log: found ? "found" : "not found" };
  }
  const { file, pattern } = "match" in check ? check.match : check["no-match"];
  const text = await readFile(join(app, file), "utf8").catch(() => undefined);
  if (text === undefined) return { passed: false, log: `${file} does not exist` };
  const matched = new RegExp(pattern, "m").test(text);
  return { passed: "match" in check ? matched : !matched, log: matched ? "matched" : "no match" };
}

/** The commit `app` holds before the agent runs: what its diff is taken against. */
export async function baselineOf(app: string) {
  return (await must(["git", "rev-parse", "HEAD"], app)).trim();
}

/**
 * Everything that changed in `app` since `baseline`: committed, staged, unstaged and
 * untracked alike, because an agent may commit its work or leave it in the tree.
 */
export async function diffSince(app: string, baseline: string) {
  await must(["git", "add", "-A"], app);
  return must(["git", "diff", "--cached", "--binary", baseline], app);
}

/** Commits everything in `app` as the runner, even nothing: the commit a run starts from. */
export async function commitAll(app: string, message: string) {
  await must(["git", "add", "-A"], app);
  await must(
    [
      "git",
      "-c",
      "user.name=skills-eval",
      "-c",
      "user.email=skills-eval@luciole.invalid",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      message,
    ],
    app,
  );
}

/**
 * Runs a scenario's `setup` in `app` (`sh -c`, at most as long as a check), with the scenario's
 * directory as `$SCENARIO_DIR`, then commits what it changed, so the baseline holds it.
 */
export async function runSetup(
  setup: string,
  app: string,
  options: { scenarioDir: string; timeoutMs?: number },
): Promise<{ passed: boolean; log: string }> {
  const result = await run(["sh", "-c", setup], app, {
    timeoutMs: options.timeoutMs ?? CHECK_TIMEOUT_MS,
    env: { SCENARIO_DIR: options.scenarioDir },
  });
  const status = result.timedOut ? "timed out" : `exit ${result.code}`;
  const passed = result.code === 0 && !result.timedOut;
  if (passed) await commitAll(app, "setup");
  return { passed, log: `${status}\n${result.output}` };
}

/**
 * One run in `app`, a fresh copy of a base: the scenario's setup, then the agent's command,
 * then the checks. It writes `setup.log` (when the scenario has a setup), `transcript.jsonl`,
 * `diff.patch` and `checks.log` to `out`. A setup that fails starts no agent and no check.
 */
export async function runInApp(options: {
  scenario: Scenario;
  scenarioDir: string;
  app: string;
  out: string;
  agent: readonly string[];
}): Promise<Omit<RunResult, "scenario" | "arm" | "run">> {
  const { scenario, app, out } = options;
  if (scenario.setup !== undefined) {
    const setup = await runSetup(scenario.setup, app, { scenarioDir: options.scenarioDir });
    await writeFile(join(out, "setup.log"), setup.log);
    if (!setup.passed) return { checks: [], agent: "setup failed", seconds: 0 };
  }
  const baseline = await baselineOf(app);

  const started = performance.now();
  const agent = await run(options.agent, app, {
    timeoutMs: scenario.timeoutMinutes * MS_PER_MINUTE,
  });
  const seconds = (performance.now() - started) / MS_PER_SECOND;
  await writeFile(join(out, "transcript.jsonl"), agent.output);

  await writeFile(join(out, "diff.patch"), await diffSince(app, baseline));

  const checks: boolean[] = [];
  const logs: string[] = [];
  for (const check of scenario.checks) {
    const result = await runCheck(check, app);
    checks.push(result.passed);
    logs.push(`## ${describeCheck(check)}: ${result.passed ? "pass" : "FAIL"}\n${result.log}`);
  }
  await writeFile(join(out, "checks.log"), logs.join("\n\n"));
  return {
    checks,
    skillRead: scenario.expectSkill ? readsSkill(agent.output, scenario.expectSkill) : undefined,
    agent: agent.timedOut ? "timeout" : agent.code === 0 ? "ok" : `exit ${agent.code}`,
    seconds,
  };
}
