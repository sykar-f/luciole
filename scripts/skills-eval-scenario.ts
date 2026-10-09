import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

/**
 * The parts of `scripts/skills-eval.ts` that run without Codex: the scenario format, the
 * command line, processes and their groups, the setup, the checks, the run's diff, a run's
 * layout and the agent's sandboxed command, one run in an app copy with the agent's command
 * given, the split of the installed app into the arms' bases, what a transcript shows the agent
 * read and wrote, and the report's table. The format is documented in evals/skills/README.md.
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

/** Literal absolute or relative paths named by a successful command, including quoted paths. */
function otherStorePath(command: string, store: { directory: string; root: string; app: string }) {
  const paths = command.match(/(?:\/|\.\.\/|\.\/)[^\s'"`;$|&()<>]+/g) ?? [];
  return paths.some((path) => {
    const absolute = resolve(store.app, path);
    return inside(absolute, store.directory) && !inside(absolute, store.root);
  });
}

// The events of `codex exec --json` that carry a shell command the agent ran. Codex writes one
// when the command starts, with `exit_code: null`, and one when it ends, with its exit code and
// what it printed.
const CommandEvent = z.looseObject({
  item: z.looseObject({
    type: z.literal("command_execution"),
    command: z.string(),
    aggregated_output: z.string().optional(),
    exit_code: z.number().nullable().optional(),
  }),
});

/** The shell commands of a `codex exec --json` transcript that ran and exited 0. */
export function succeededCommands(transcript: string): { command: string; output: string }[] {
  return transcript.split("\n").flatMap((line) => {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return [];
    }
    const parsed = CommandEvent.safeParse(event);
    if (!parsed.success || parsed.data.item.exit_code !== 0) return [];
    const { command, aggregated_output: output = "" } = parsed.data.item;
    return [{ command, output }];
  });
}

/**
 * Whether a `codex exec --json` transcript shows the agent reading `skill`'s SKILL.md: a
 * command it ran names the file and exited 0. A `cat` of a file that does not exist fails, so
 * it does not count; nor does the skill's description, which the agent sees without reading
 * anything.
 */
export function readsSkill(transcript: string, skill: string): boolean {
  const path = `${skill}/SKILL.md`;
  return succeededCommands(transcript).some(({ command }) => command.includes(path));
}

/** How many words of a skill's description its fingerprint holds. */
const FINGERPRINT_WORDS = 4;

/**
 * What a skill's own text begins with, wherever a copy of it sits: its frontmatter's `name:`
 * line, and the first words of its description. Output that holds both carries the skill.
 */
export interface Fingerprint {
  name: RegExp;
  description: RegExp;
}

const SkillFrontmatter = z.looseObject({ name: z.string(), description: z.string() });
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * The space between two words of a text as a command prints it: a JSON log escapes its
 * newlines, once or, in a log of a log, more.
 */
const GAP = String.raw`(?:\s|\\+n)+`;

/** The fingerprint of a SKILL.md's text, or nothing when it has no name and description. */
export function fingerprintOf(skillMd: string): Fingerprint | undefined {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd)?.[1];
  if (frontmatter === undefined) return undefined;
  const parsed = SkillFrontmatter.safeParse(Bun.YAML.parse(frontmatter));
  if (!parsed.success) return undefined;
  const words = parsed.data.description.split(/\s+/).filter(Boolean).slice(0, FINGERPRINT_WORDS);
  if (!words.length) return undefined;
  return {
    name: new RegExp(
      String.raw`name:[ \t]*["']?${escapeRegExp(parsed.data.name)}["']?(?:\s|\\+n|$)`,
    ),
    description: new RegExp(words.map(escapeRegExp).join(GAP)),
  };
}

/** A reference's first heading and the first words after it, as a search prints them. */
export function referenceFingerprintOf(text: string): Fingerprint | undefined {
  const heading = /^#{1,6}[^\S\r\n]+[^\r\n]+/m.exec(text);
  if (!heading) return undefined;
  const words = text
    .slice(heading.index + heading[0].length)
    .trim()
    .split(/\s+/)
    .slice(0, FINGERPRINT_WORDS);
  if (!words[0]) return undefined;
  return {
    name: new RegExp(escapeRegExp(heading[0])),
    description: new RegExp(words.map(escapeRegExp).join(GAP)),
  };
}

/**
 * References as installed in the with base. Deny a basename only when the without base
 * has no legitimate file of that name; otherwise the contamination guard covers its text.
 */
export async function referencePolicy(skillDirectory: string, withoutApp: string) {
  const legitimate = new Set<string>();
  for await (const file of new Bun.Glob("**/*").scan({
    cwd: withoutApp,
    dot: true,
    onlyFiles: true,
  }))
    legitimate.add(basename(file));
  const denies = new Set<string>();
  const fingerprints: Fingerprint[] = [];
  const references = join(skillDirectory, "references");
  if (!(await readdir(references).catch(() => [])).length) return { denies: [], fingerprints };
  for await (const file of new Bun.Glob("**/*").scan({ cwd: references, onlyFiles: true })) {
    const fingerprint = referenceFingerprintOf(await readFile(join(references, file), "utf8"));
    if (fingerprint) fingerprints.push(fingerprint);
    const name = basename(file);
    if (!legitimate.has(name)) denies.add(`/**/${name}`);
  }
  return { denies: [...denies].sort(), fingerprints };
}

/**
 * What a command names when it reads a Codex session's log: a rollout, the session index, the
 * prompt history, or a home's session directories. Those logs hold the full output of every
 * command an earlier session ran, a `cat` of a skill included.
 */
const SESSION_STORE =
  /rollout-[^\s'"]*\.jsonl|session_index\.jsonl|\.codex\/history\.jsonl|\.codex\/(?:archived_)?sessions\b|(?:archived_)?sessions\/\d{4}\//;

/**
 * The commands of a transcript, run with success, that read the material of `skill`: they name
 * its SKILL.md, a file of its `references/`, the AGENTS.md block's source `agents-block.md`, or
 * a Codex session's log; or what they printed holds the skill's `fingerprint`, which a search
 * through a copy of it shows. The without arm has none of it to read; such a run is
 * contaminated.
 */
export function materialReads(
  transcript: string,
  material: {
    skill: string;
    fingerprint?: Fingerprint;
    references?: readonly Fingerprint[];
    store?: { directory: string; root: string; app: string };
  },
): string[] {
  const names = [`${material.skill}/SKILL.md`, `${material.skill}/references/`, "agents-block.md"];
  const { fingerprint } = material;
  return succeededCommands(transcript)
    .filter(
      ({ command, output }) =>
        names.some((name) => command.includes(name)) ||
        SESSION_STORE.test(command) ||
        (material.store !== undefined && otherStorePath(command, material.store)) ||
        (fingerprint !== undefined &&
          fingerprint.name.test(output) &&
          fingerprint.description.test(output)) ||
        material.references?.some(
          (reference) => reference.name.test(output) && reference.description.test(output),
        ),
    )
    .map(({ command }) => command);
}

// The events of `codex exec --json` that carry the files the agent's patches wrote.
const FileChangeEvent = z.looseObject({
  item: z.looseObject({
    type: z.literal("file_change"),
    changes: z.array(z.looseObject({ path: z.string() })),
  }),
});

/**
 * The paths a transcript's `file_change` events wrote outside `app`, each once, whether the
 * sandbox let the write through or not. Codex names them absolute, through the real path of
 * the app (`/private/var/…` for `/var/…` on macOS): `app` lists each spelling of its root.
 */
export function writesOutside(transcript: string, app: readonly string[]): string[] {
  const inside = (path: string) =>
    app.some((root) => path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`));
  const paths = transcript.split("\n").flatMap((line) => {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return [];
    }
    const parsed = FileChangeEvent.safeParse(event);
    if (!parsed.success) return [];
    return parsed.data.item.changes
      .map((change) => (isAbsolute(change.path) ? change.path : join(app[0] ?? "", change.path)))
      .filter((path) => !inside(path));
  });
  return [...new Set(paths)];
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
  /**
   * The commands of a without run that read the skill under test or the AGENTS.md block, which
   * that arm must not find: the run is contaminated. Absent in the with arm, and when the agent
   * never started.
   */
  contamination?: readonly string[];
  /** The paths the agent wrote outside its app. Absent when the agent never started. */
  outside?: readonly string[];
  /** Whether the agent ran out of time or exited non-zero, or never started. */
  agent: "ok" | "timeout" | `exit ${number}` | "setup failed";
  /** The agent's live processes that its cleanup could not end, when there are any. */
  left?: number;
  seconds: number;
}

/** How the agent ended, and what its cleanup left behind. */
const outcome = (result: RunResult) =>
  result.left ? `${result.agent}, cleanup: ${result.left} left` : result.agent;

/** A list a run may have found something in: `-` where it does not apply. */
const flagOf = (found: readonly string[] | undefined) =>
  found === undefined ? "-" : found.length ? "YES" : "no";

/**
 * The report: one row per scenario, arm and run, then the legend of the check columns, then
 * what made a run contaminated and what it wrote outside its app.
 */
export function renderTable(results: readonly RunResult[], scenarios: readonly Scenario[]) {
  const width = Math.max(0, ...scenarios.map((s) => s.checks.length));
  const header = [
    "scenario",
    "arm",
    "run",
    ...Array.from({ length: width }, (_, i) => `c${i + 1}`),
    "skill read",
    "contaminated",
    "wrote outside",
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
    flagOf(result.contamination),
    flagOf(result.outside),
    outcome(result),
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
  const listed = (title: string, pick: (result: RunResult) => readonly string[] | undefined) => {
    const lines = results.flatMap((result) =>
      (pick(result) ?? []).map(
        (what) => `  ${result.scenario} ${result.arm} ${result.run}: ${what}`,
      ),
    );
    return lines.length ? ["", title, ...lines] : [];
  };
  return [
    line(header),
    `|${widths.map((w) => "-".repeat(w + 2)).join("|")}|`,
    ...rows.map(line),
    "",
    "Checks:",
    ...legend,
    ...listed("Contaminated (the material read in the without arm):", (r) => r.contamination),
    ...listed("Written outside the app:", (r) => r.outside),
  ].join("\n");
}

export interface Ran {
  code: number;
  output: string;
  timedOut: boolean;
  /** The group's live members that survived its end: none, unless the system refused. */
  left: number;
}

/** `process.kill`, or a stand-in for it. */
export type Kill = (pid: number, signal: NodeJS.Signals | 0) => void;

/** How a process group ends: who signals it, and how long it may take to disappear. */
export interface Cleanup {
  kill?: Kill;
  goneMs?: number;
}

/** How long a process group may take to disappear once killed. */
const GROUP_GONE_MS = 5000;
const GROUP_POLL_MS = 20;

const errorCode = (error: unknown) =>
  error instanceof Error && "code" in error ? error.code : undefined;

const PsLine = /^\s*(\d+)\s+(\d+)\s+(\S+)/;

/**
 * The members of the process group `id` that still run: zombies, which only wait for their
 * parent to read their status, do not count.
 */
async function liveMembers(id: number, kill: Kill): Promise<number[]> {
  try {
    kill(-id, 0);
  } catch (error: unknown) {
    if (errorCode(error) === "ESRCH") return [];
  }
  const ps = Bun.spawn(["ps", "-A", "-o", "pid=", "-o", "pgid=", "-o", "stat="], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const listing = await new Response(ps.stdout).text();
  await ps.exited;
  return listing.split("\n").flatMap((line) => {
    const [, pid, pgid, stat] = PsLine.exec(line) ?? [];
    return Number(pgid) === id && !stat?.startsWith("Z") ? [Number(pid)] : [];
  });
}

/**
 * Kills every process of the group `id` and waits until none is left. An agent starts servers,
 * watchers and test runners; none may outlive its run, hold its copy of the app, or keep a port.
 * The system may refuse a signal (EPERM, as macOS does for a group whose members changed
 * credentials): then each live member is signalled on its own. Ending a group never throws, so
 * a cleanup cannot abort a pass; it returns how many live members are left, which the run
 * reports.
 */
export async function endGroup(id: number, options: Cleanup = {}): Promise<number> {
  const kill =
    options.kill ??
    ((pid, signal) => {
      process.kill(pid, signal);
    });
  try {
    kill(-id, "SIGKILL");
  } catch (error: unknown) {
    if (errorCode(error) === "ESRCH") return 0;
  }
  const deadline = performance.now() + (options.goneMs ?? GROUP_GONE_MS);
  for (;;) {
    const left = await liveMembers(id, kill);
    if (!left.length) return 0;
    if (performance.now() > deadline) return left.length;
    for (const pid of left)
      try {
        kill(pid, "SIGKILL");
      } catch {
        // Refused or already gone: the next listing tells.
      }
    await Bun.sleep(GROUP_POLL_MS);
  }
}

/** A stream read as it comes: what it said so far, its end, and a way to stop reading. */
function collect(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const done = (async () => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  })().catch(() => undefined);
  return { done, text: () => text, cancel: () => reader.cancel().catch(() => undefined) };
}

/**
 * Runs `cmd` with stdin closed, as the leader of its own process group: on timeout, and after
 * it exits, the whole group ends, children and grandchildren included.
 */
export async function run(
  cmd: readonly string[],
  cwd: string,
  options: {
    timeoutMs?: number;
    env?: Readonly<Record<string, string>>;
    cleanup?: Cleanup;
    /** Registers the live group with its run owner before waiting for the agent. */
    onSpawn?: (id: number) => void;
  } = {},
): Promise<Ran> {
  if (interrupting) throw new Error("Eval runner is interrupting; no new process may start");
  const owner = [...authCopies.values()].find(
    ({ root, report }) =>
      (root !== undefined && inside(cwd, root)) || (report !== undefined && inside(cwd, report)),
  );
  const child = Bun.spawn([...cmd], {
    cwd,
    env: { ...process.env, ...options.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  owner?.groups.add(child.pid);
  options.onSpawn?.(child.pid);
  // Read while it runs: a full pipe would stall it. A child that keeps the pipe open keeps
  // the read pending until the group ends below.
  const out = collect(child.stdout);
  const err = collect(child.stderr);
  let timedOut = false;
  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          void endGroup(child.pid, options.cleanup);
        }, options.timeoutMs);
  const code = await child.exited;
  clearTimeout(timer);
  const left = await endGroup(child.pid, options.cleanup);
  owner?.groups.delete(child.pid);
  // A member left alive may hold the pipes open forever: keep what they said until now.
  if (left) await Promise.all([out.cancel(), err.cancel()]);
  await Promise.all([out.done, err.done]);
  return { code, output: out.text() + err.text(), timedOut, left };
}

/** `run`, which must exit 0: its output, or a thrown error that holds it. */
export async function must(cmd: readonly string[], cwd: string) {
  const result = await run(cmd, cwd);
  if (result.code !== 0) throw new Error(`${cmd.join(" ")} failed in ${cwd}:\n${result.output}`);
  return result.output;
}

/** Copy an app, using clone-on-write on macOS when the filesystem supports it. */
export async function copyApp(from: string, to: string, cwd = dirname(to)) {
  if (process.platform === "darwin") {
    const cloned = await run(["/bin/cp", "-R", "-c", from, to], cwd);
    if (cloned.code === 0) return;
    await rm(to, { recursive: true, force: true });
  }
  await must(["cp", "-R", from, to], cwd);
}

function canonicalPath(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

const inside = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/** A live run sits outside denied temporary ancestors; reports stay in tmpdir. */
export const runStoreIn = (home: string, cache?: string) =>
  join(cache || join(home, ".cache"), "luciole-skills-eval");

/** Snapshot existing store entries. A later concurrent entry is covered by the guard. */
export async function deniedStoreEntries(store: string, own: string): Promise<string[]> {
  return [
    ...(await readdir(store)).map((name) => join(store, name)).filter((path) => path !== own),
    runLayout(own).codex,
  ].sort();
}

/** Reserve and own the store directory synchronously, before any staging can be interrupted. */
export async function withStoredRun<T>(
  store: string,
  roots: readonly string[],
  work: (root: string) => Promise<T>,
): Promise<T> {
  if (interrupting) throw new Error("Eval runner is interrupting; no new run may start");
  mkdirSync(store, { recursive: true });
  const canonical = realpathSync(store);
  if (
    roots.some((root) => inside(canonical, resolve(root)) || inside(canonical, canonicalPath(root)))
  )
    throw new Error("The eval run store must be outside every unreadable root");
  const root = mkdtempSync(join(canonical, "run-"));
  const auth = join(runLayout(root).codex, "auth.json");
  registerAuth(auth, root);
  try {
    return await work(root);
  } catch (error: unknown) {
    if (interrupting)
      await new Promise<never>(() => {
        // Keep the interrupted caller pending: the owner exits after group and store cleanup.
      });
    throw error;
  } finally {
    rmSync(root, { recursive: true, force: true });
    releaseAuth(auth);
  }
}

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;
/** How long one check command may run. */
const CHECK_TIMEOUT_MINUTES = 10;
export const CHECK_TIMEOUT_MS = CHECK_TIMEOUT_MINUTES * MS_PER_MINUTE;

/** How a command ended, for its log. */
const statusOf = (result: Ran) =>
  `${result.timedOut ? "timed out" : `exit ${result.code}`}${result.left ? `, cleanup: ${result.left} left` : ""}`;

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
    const status = statusOf(result);
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

/** Where an app holds the installed `@luciole-sh/core`, relative to its root. */
export const CORE_PACKAGE = "node_modules/@luciole-sh/core";
/** What the package ships for agents, relative to it: absent from the without arm. */
export const AGENT_MATERIAL: readonly string[] = ["skills", "agents-block.md"];

/**
 * Makes the arms' bases from the installed app at `without`: `copy` it to `with`, `install`
 * the agent material there, which reads the package's own copy, then remove that material from
 * `without`'s package. Grepping node_modules then finds no skill in the without arm; the
 * package's docs stay in both, as every user receives them.
 */
export async function splitBases(options: {
  without: string;
  with: string;
  copy: (from: string, to: string) => Promise<void>;
  install: (app: string) => Promise<void>;
}) {
  await options.copy(options.without, options.with);
  await options.install(options.with);
  for (const entry of AGENT_MATERIAL)
    await rm(join(options.without, CORE_PACKAGE, entry), { recursive: true, force: true });
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
  const status = statusOf(result);
  const passed = result.code === 0 && !result.timedOut;
  if (passed) await commitAll(app, "setup");
  return { passed, log: `${status}\n${result.output}` };
}

/**
 * Where a run's files go under its root `out`. While the agent runs, the root holds only these:
 * the app, the copy the agent works in; `tmp`, its `$TMPDIR`; and `codex`, its `$CODEX_HOME`,
 * where Codex finds no session but this one and writes this one's log. The logs, the transcript
 * and the diff are written there once it has ended.
 */
export function runLayout(out: string) {
  return { app: join(out, "app"), tmp: join(out, "tmp"), codex: join(out, "codex") };
}

/** The name of the permissions profile the agent runs under. */
const PROFILE = "skills_eval";

/** The skill a scenario belongs to, the directory it sits in: the skill under test. */
export const skillOf = (scenario: Scenario) => scenario.name.split("/")[0] ?? scenario.name;

/**
 * What the agent of a run of `arm` may not read: `roots`, the directories that hold the other
 * runs and reports, the skills' sources and the Codex sessions' logs. In the without arm,
 * single-component patterns deny every SKILL.md, the AGENTS.md block's source, and reference
 * basenames that do not collide with legitimate app files. Nested global patterns prevent
 * directory deletion under Codex 0.160's Seatbelt ancestor protection.
 */
export function unreadableFor(options: {
  arm: Arm;
  skill: string;
  roots: readonly string[];
  references?: readonly string[];
}): string[] {
  const material = ["/**/SKILL.md", ...(options.references ?? []), "/**/agents-block.md"];
  return [...options.roots, ...(options.arm === "without" ? material : [])];
}

/**
 * The Codex command of one run. Its permissions profile replaces `workspace-write`, which keeps
 * `.agents/` and `.git/` read-only inside the app, so `luciole skills` could not refresh the
 * material nor the agent commit, and which lets the agent write in the system's `$TMPDIR` and
 * `/tmp`, where the report lives. Under this profile the agent writes in `app`, those two
 * included, and in `tmp`, and nowhere else; it reads the rest of the disk, except the paths and
 * patterns of `unreadable`, which no command it runs can list or open. A pattern wins over a
 * path, even inside `app`. The managed network proxy allows only loopback destinations;
 * local binding permits app servers. Codex 0.160 also allows direct outbound DNS on port 53.
 */
export function agentCommand(options: {
  app: string;
  tmp: string;
  model: string;
  prompt: string;
  unreadable: readonly string[];
}): string[] {
  const path = (value: string) => JSON.stringify(value);
  const filesystem = [
    `"/" = "read"`,
    ...options.unreadable.map((directory) => `${path(directory)} = "deny"`),
    `${path(options.tmp)} = "write"`,
    `":workspace_roots" = { "." = "write", ".agents" = "write", ".git" = "write" }`,
  ];
  return [
    "codex",
    "exec",
    "-m",
    options.model,
    "--skip-git-repo-check",
    "--json",
    "-C",
    options.app,
    "-c",
    `default_permissions=${path(PROFILE)}`,
    "-c",
    `permissions.${PROFILE}.filesystem={ ${filesystem.join(", ")} }`,
    "-c",
    "features.network_proxy=true",
    "-c",
    `permissions.${PROFILE}.network={ enabled = true, allow_local_binding = true, ` +
      'domains = { "localhost" = "allow", "127.0.0.1" = "allow", "::1" = "allow" } }',
    options.prompt,
  ];
}

/** The user's auth file, when present; environment authentication needs no file. */
export async function codexAuthIn(home: string): Promise<string | undefined> {
  const auth = join(home, "auth.json");
  return (await Bun.file(auth).exists()) ? auth : undefined;
}

// One owner for every run's credential copy and live agent group, including concurrent runs
// and runs without file authentication. Copy and removal are synchronous so a signal cannot
// exit while a pending copy recreates the file after cleanup.
const authCopies = new Map<string, { groups: Set<number>; root?: string; report?: string }>();
let interrupting = false;
const INTERRUPTED_EXIT = 130;
const TERMINATED_EXIT = 143;
async function interruptAuthCopies(signal: "SIGINT" | "SIGTERM") {
  if (interrupting) return;
  interrupting = true;
  const groups = [...authCopies.values()].flatMap(({ groups }) => [...groups]);
  for (const auth of authCopies.keys()) rmSync(auth, { force: true });
  await Promise.all(groups.map((id) => endGroup(id)));
  // A finishing run may have changed the owner while cleanup was awaited.
  for (const auth of authCopies.keys()) rmSync(auth, { force: true });
  await Promise.all(
    [...authCopies.values()].flatMap(({ groups }) => [...groups].map((id) => endGroup(id))),
  );
  for (const { root } of authCopies.values())
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  process.exit(signal === "SIGINT" ? INTERRUPTED_EXIT : TERMINATED_EXIT);
}
const onAuthInterrupt = () => void interruptAuthCopies("SIGINT");
const onAuthTerminate = () => void interruptAuthCopies("SIGTERM");

function registerAuth(auth: string, root?: string) {
  if (interrupting) throw new Error("Eval runner is interrupting; no new agent may start");
  if (authCopies.has(auth)) return;
  if (!authCopies.size) {
    process.on("SIGINT", onAuthInterrupt);
    process.on("SIGTERM", onAuthTerminate);
  }
  authCopies.set(auth, { groups: new Set(), root });
}

function copyAuth(source: string | undefined, auth: string) {
  registerAuth(auth);
  if (source !== undefined) copyFileSync(source, auth);
}

function releaseAuth(auth: string) {
  authCopies.delete(auth);
  if (!authCopies.size) {
    process.off("SIGINT", onAuthInterrupt);
    process.off("SIGTERM", onAuthTerminate);
  }
}

function removeAuth(auth: string) {
  rmSync(auth, { force: true });
  // Stored runs remain owned through the result copy and checks.
  if (authCopies.get(auth)?.root === undefined) releaseAuth(auth);
}

/**
 * One run of `arm` in `app`, a fresh copy of a base under `runRoot` (or `out` for a fixture): the scenario's setup, then the agent's command with `$TMPDIR` and `$CODEX_HOME`
 * in the root, then the checks. The Codex home holds a copy of `codexAuth` while the agent runs,
 * and only its own session's log afterwards. It writes `setup.log` (when the scenario has a
 * setup), `transcript.jsonl`, `diff.patch` and `checks.log` to `out`. A setup that fails starts
 * no agent and no check.
 */
export async function runInApp(options: {
  scenario: Scenario;
  arm: Arm;
  scenarioDir: string;
  app: string;
  out: string;
  /** The live store root, when results must be copied back to out. */
  runRoot?: string;
  agent: readonly string[];
  /** The credentials Codex starts with, copied into the run's Codex home for the run only. */
  codexAuth?: string;
  /** The skill under test's fingerprint, when the skill exists, for the contamination guard. */
  fingerprint?: Fingerprint;
  references?: readonly Fingerprint[];
  /** How the agent's process group ends: `process.kill` unless a test stands in for it. */
  cleanup?: Cleanup;
}): Promise<Omit<RunResult, "scenario" | "arm" | "run">> {
  const { scenario, app, out, arm } = options;
  const stored =
    options.runRoot === undefined
      ? undefined
      : authCopies.get(join(runLayout(options.runRoot).codex, "auth.json"));
  if (stored !== undefined) stored.report = out;
  // The setup's log waits for the agent's end: nothing but the layout is in the root before.
  let setupLog: string | undefined;
  if (scenario.setup !== undefined) {
    const setup = await runSetup(scenario.setup, app, { scenarioDir: options.scenarioDir });
    if (!setup.passed) {
      await writeFile(join(out, "setup.log"), setup.log);
      if (options.runRoot !== undefined) await copyApp(app, join(out, "app"), options.runRoot);
      return { checks: [], agent: "setup failed", seconds: 0 };
    }
    setupLog = setup.log;
  }
  const baseline = await baselineOf(app);
  const { tmp, codex } = runLayout(options.runRoot ?? out);
  await mkdir(tmp, { recursive: true });
  await mkdir(codex, { recursive: true });
  const auth = join(codex, "auth.json");
  const started = performance.now();
  let agent: Ran;
  try {
    copyAuth(options.codexAuth, auth);
    if (interrupting) throw new Error("Eval runner is interrupting; no new agent may start");
    agent = await run(options.agent, app, {
      timeoutMs: scenario.timeoutMinutes * MS_PER_MINUTE,
      env: { TMPDIR: tmp, CODEX_HOME: codex },
      cleanup: options.cleanup,
      onSpawn: (id) => authCopies.get(auth)?.groups.add(id),
    });
  } finally {
    // The report outlives the run: the credentials must not.
    removeAuth(auth);
  }
  const seconds = (performance.now() - started) / MS_PER_SECOND;
  if (setupLog !== undefined) await writeFile(join(out, "setup.log"), setupLog);
  await writeFile(join(out, "transcript.jsonl"), agent.output);

  await writeFile(join(out, "diff.patch"), await diffSince(app, baseline));

  const checksApp = options.runRoot === undefined ? app : join(out, "app");
  if (options.runRoot !== undefined) {
    await copyApp(app, checksApp, options.runRoot);
    await copyApp(codex, join(out, "codex"), options.runRoot);
  }
  const checks: boolean[] = [];
  const logs: string[] = [];
  for (const check of scenario.checks) {
    const result = await runCheck(check, checksApp);
    checks.push(result.passed);
    logs.push(`## ${describeCheck(check)}: ${result.passed ? "pass" : "FAIL"}\n${result.log}`);
  }
  await writeFile(join(out, "checks.log"), logs.join("\n\n"));
  return {
    checks,
    skillRead: scenario.expectSkill ? readsSkill(agent.output, scenario.expectSkill) : undefined,
    contamination:
      arm === "without"
        ? materialReads(agent.output, {
            skill: skillOf(scenario),
            fingerprint: options.fingerprint,
            references: options.references,
            store:
              options.runRoot === undefined
                ? undefined
                : {
                    directory: dirname(options.runRoot),
                    root: options.runRoot,
                    app,
                  },
          })
        : undefined,
    outside: writesOutside(agent.output, [app, await realpath(app)]),
    agent: agent.timedOut ? "timeout" : agent.code === 0 ? "ok" : `exit ${agent.code}`,
    left: agent.left || undefined,
    seconds,
  };
}

/**
 * Runs each of `items` in turn and rewrites `report` (the table) after each one, so a failure
 * later in the pass keeps the rows of the runs before it.
 */
export async function runPass<T>(
  items: readonly T[],
  runOne: (item: T) => Promise<RunResult>,
  options: { scenarios: readonly Scenario[]; report: string },
): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (const item of items) {
    results.push(await runOne(item));
    await writeFile(options.report, `${renderTable(results, options.scenarios)}\n`);
  }
  return results;
}
