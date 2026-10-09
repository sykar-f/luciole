import { afterAll, expect, test } from "bun:test";
import { z } from "zod";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  agentCommand,
  AGENT_MATERIAL,
  baselineOf,
  CORE_PACKAGE,
  codexAuthIn,
  copyApp,
  deniedStoreEntries,
  runStoreIn,
  withStoredRun,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MINUTES,
  diffSince,
  must,
  parseArgs,
  parseScenario,
  fingerprintOf,
  referenceFingerprintOf,
  referencePolicy,
  materialReads,
  readsSkill,
  renderTable,
  run,
  runCheck,
  runInApp,
  runLayout,
  runPass,
  splitBases,
  unreadableFor,
  writesOutside,
  type Kill,
  type RunResult,
  type Scenario,
} from "../scripts/skills-eval-scenario";

import { rejectionOf } from "./helpers";

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

/** A `command_execution` item as `codex exec --json` writes it once the command has ended. */
const ran = (command: string, exitCode: number, output = "") =>
  event({
    id: "item_1",
    type: "command_execution",
    command: `/bin/zsh -lc '${command}'`,
    aggregated_output: output,
    exit_code: exitCode,
    status: exitCode === 0 ? "completed" : "failed",
  });

test("a skill counts as read when a command the agent ran names its SKILL.md", () => {
  const read = ran("cat .agents/skills/luciole-app/SKILL.md", 0);
  expect(readsSkill(read, "luciole-app")).toBe(true);
  expect(readsSkill(read, "luciole-test")).toBe(false);
  // A message that names the file is not a read; nor is a line that is not an event.
  const said = event({ type: "agent_message", text: "see .agents/skills/luciole-app/SKILL.md" });
  expect(readsSkill([said, "cat luciole-app/SKILL.md"].join("\n"), "luciole-app")).toBe(false);
});

test("a command that failed is not a read, nor one that has not ended", () => {
  const failed = ran("cat .agents/skills/luciole-upgrade/SKILL.md 2>/dev/null", 1);
  expect(readsSkill(failed, "luciole-upgrade")).toBe(false);
  // Codex announces the command before it runs it, with no exit code yet.
  const started = JSON.stringify({
    type: "item.started",
    item: {
      id: "item_1",
      type: "command_execution",
      command: "/bin/zsh -lc 'cat .agents/skills/luciole-upgrade/SKILL.md'",
      aggregated_output: "",
      exit_code: null,
      status: "in_progress",
    },
  });
  expect(readsSkill(started, "luciole-upgrade")).toBe(false);
  const succeeded = ran("cat .agents/skills/luciole-upgrade/SKILL.md", 0);
  expect(readsSkill([failed, started, succeeded].join("\n"), "luciole-upgrade")).toBe(true);
});

test("the material read in a transcript: the skill's SKILL.md or the block, read with success", () => {
  const transcript = [
    ran("cat ~/.codex/skills/luciole-upgrade/SKILL.md", 1),
    ran("cat ../with-1/app/.agents/skills/luciole-upgrade/SKILL.md", 0),
    ran("cat ~/.agents/skills/cloudflare/SKILL.md", 0),
    ran("rg -n upgrade node_modules/@luciole-sh/core/agents-block.md", 0),
    ran("cat package.json", 0),
  ].join("\n");
  expect(materialReads(transcript, { skill: "luciole-upgrade" })).toEqual([
    "/bin/zsh -lc 'cat ../with-1/app/.agents/skills/luciole-upgrade/SKILL.md'",
    "/bin/zsh -lc 'rg -n upgrade node_modules/@luciole-sh/core/agents-block.md'",
  ]);
});

/** The opening of luciole-ship's SKILL.md, as skill-ship's report found it in a Codex log. */
const SHIP = [
  "---",
  "name: luciole-ship",
  "description: Ships a luciole app — compiled binaries, macOS signing and notarization, a hosted Server, the web target and npm packages with luciole pack.",
  "disable-model-invocation: true",
  "---",
  "",
  "# Ship a luciole app",
  "",
].join("\n");

test("a skill's fingerprint: its name line and its description's first words", () => {
  const fingerprint = fingerprintOf(SHIP);
  expect(fingerprint?.name.test("name: luciole-ship\n")).toBe(true);
  expect(fingerprint?.name.test("name: luciole-shipping\n")).toBe(false);
  expect(fingerprint?.description.test("description: Ships a luciole app")).toBe(true);
  // A folded description breaks its words over lines.
  expect(fingerprint?.description.test("Ships a\n  luciole app")).toBe(true);
  expect(fingerprintOf("# no frontmatter")).toBeUndefined();
  expect(fingerprintOf("---\nname: x\n---\n")).toBeUndefined();
});

test("reference openings detect renamed copies without confusing the docs", async () => {
  const reference =
    "# Routing\n\nThe full rules: `node_modules/@luciole-sh/core/docs/concepts/routing.md`.\n";
  const fingerprint = referenceFingerprintOf(reference);
  expect(fingerprint).toBeDefined();
  expect(referenceFingerprintOf("no heading")).toBeUndefined();
  expect(referenceFingerprintOf("# Empty\n")).toBeUndefined();
  const skillDirectory = join(temp, "reference-skill");
  const app = join(temp, "reference-app");
  await mkdir(join(skillDirectory, "references", "nested"), { recursive: true });
  await mkdir(join(app, "node_modules", "@luciole-sh", "core", "docs"), { recursive: true });
  await writeFile(join(skillDirectory, "references", "routing.md"), reference);
  await writeFile(
    join(skillDirectory, "references", "nested", "auth.md"),
    "# Auth\n\nSign in before reading anything.\n",
  );
  await writeFile(
    join(app, "node_modules", "@luciole-sh", "core", "docs", "routing.md"),
    "# Routing\n\nRoutes map pages to paths.\n",
  );
  const policy = await referencePolicy(skillDirectory, app);
  expect(policy.denies).toEqual(["/**/auth.md"]);
  expect(policy.fingerprints).toHaveLength(2);
  const transcript = [
    ran("cat copied.txt", 0, reference),
    ran("rg full cached.json", 0, JSON.stringify({ text: reference })),
    ran("cat failed.txt", 1, reference),
    ran("cat docs/routing.md", 0, "# Routing\n\nRoutes map pages to paths.\n"),
  ].join("\n");
  expect(
    materialReads(transcript, { skill: "luciole-app", references: policy.fingerprints }),
  ).toEqual(["/bin/zsh -lc 'cat copied.txt'", "/bin/zsh -lc 'rg full cached.json'"]);
  expect(
    unreadableFor({
      arm: "without",
      skill: "luciole-app",
      roots: ["/r"],
      references: policy.denies,
    }),
  ).toEqual(["/r", "/**/SKILL.md", "/**/auth.md", "/**/agents-block.md"]);
});

test("a without run that read the skill through a Codex log is contaminated", () => {
  const fingerprint = fingerprintOf(SHIP);
  // skill-ship's TaedsM without-1: rg printed rollout lines, whose JSON escapes the newlines.
  const logged = JSON.stringify({ aggregated_output: SHIP }).slice(1, -1);
  const searched = ran(
    "rg -n luciole-ship /Users/u/.codex /Users/u/.agents 2>/dev/null",
    0,
    `/Users/u/.codex/sessions/2026/10/09/rollout-x.jsonl:12:{"type":"response_item",${logged}}`,
  );
  // A two-step read: the search names no skill path, the cat names the log.
  const listed = ran("rg -l luciole-ship /Users/u/.codex/sessions", 0, "rollout-x.jsonl\n");
  const opened = ran(
    "cat /Users/u/.codex/sessions/2026/10/09/rollout-2026-10-09T02-57-45-a.jsonl",
    0,
  );
  const history = ran("tail /Users/u/.codex/history.jsonl", 0);
  const references = ran(
    "cat node_modules/@luciole-sh/core/skills/luciole-ship/references/web.md",
    0,
  );
  const clean = ran("cat app/sessions/page.tsx", 0, "name: luciole-ship");
  const transcript = [searched, listed, opened, history, references, clean].join("\n");
  expect(materialReads(transcript, { skill: "luciole-ship", fingerprint })).toEqual([
    "/bin/zsh -lc 'rg -n luciole-ship /Users/u/.codex /Users/u/.agents 2>/dev/null'",
    "/bin/zsh -lc 'rg -l luciole-ship /Users/u/.codex/sessions'",
    "/bin/zsh -lc 'cat /Users/u/.codex/sessions/2026/10/09/rollout-2026-10-09T02-57-45-a.jsonl'",
    "/bin/zsh -lc 'tail /Users/u/.codex/history.jsonl'",
    "/bin/zsh -lc 'cat node_modules/@luciole-sh/core/skills/luciole-ship/references/web.md'",
  ]);
  // Without the fingerprint, only the commands that name the material count.
  expect(materialReads(searched, { skill: "luciole-ship" })).toEqual([]);
});

/** A `file_change` item as `codex exec --json` writes it, for each path. */
const changed = (status: string, ...paths: string[]) =>
  event({
    id: "item_7",
    type: "file_change",
    changes: paths.map((path) => ({ path, kind: "add" })),
    status,
  });

test("a write outside the app is flagged, through either spelling of its root", () => {
  const app = ["/var/r/runs/s/with-1/app", "/private/var/r/runs/s/with-1/app"];
  const transcript = [
    changed("completed", "/private/var/r/runs/s/with-1/app/app/login/page.tsx"),
    changed("completed", "/var/r/runs/s/with-1/app/components/a.tsx", "relative.ts"),
    changed("completed", "/private/var/r/components/LoginForm.tsx"),
    // Refused by the sandbox or not, it was the agent's work, and the checks do not see it.
    changed("failed", "/tmp/notes-check/app/page.tsx", "/private/var/r/runs/s/with-1/app-x/a"),
    changed("completed", "/private/var/r/components/LoginForm.tsx"),
  ].join("\n");
  expect(writesOutside(transcript, app)).toEqual([
    "/private/var/r/components/LoginForm.tsx",
    "/tmp/notes-check/app/page.tsx",
    "/private/var/r/runs/s/with-1/app-x/a",
  ]);
});

test("the without arm may not read the skill under test or the block, anywhere", () => {
  const roots = ["/var/T/", "/tmp", "/w"];
  expect(unreadableFor({ arm: "with", skill: "luciole-app", roots })).toEqual(roots);
  expect(unreadableFor({ arm: "without", skill: "luciole-app", roots })).toEqual([
    ...roots,
    "/**/SKILL.md",
    "/**/agents-block.md",
  ]);
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
        contamination: [],
        outside: [],
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
      "| scenario          | arm     | run | c1   | c2   | skill read | contaminated | wrote outside | agent   | duration |",
      "|-------------------|---------|-----|------|------|------------|--------------|---------------|---------|----------|",
      "| luciole-app/about | without | 1   | pass | FAIL | no         | no           | no            | ok      | 61s      |",
      "| luciole-app/about | with    | 1   | pass | pass | yes        | -            | -             | timeout | 90s      |",
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

/** A killed listing can remain a zombie after its runner exits without reaping it. */
async function running(pid: number) {
  const probe = Bun.spawn(["ps", "-p", String(pid), "-o", "stat="], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [state, errors, code] = await Promise.all([
    new Response(probe.stdout).text(),
    new Response(probe.stderr).text(),
    probe.exited,
  ]);
  expect(errors).toBe("");
  // ps exits 1 when the selected process no longer exists.
  expect([0, 1]).toContain(code);
  const stat = state.trim();
  return stat !== "" && !stat.startsWith("Z");
}

test("the exit probe distinguishes a running process from a reaped one", async () => {
  expect(await running(process.pid)).toBe(true);
  const child = Bun.spawn([process.execPath, "-e", ""], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(await child.exited).toBe(0);
  expect(await running(child.pid)).toBe(false);
});

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

/** Publish a child-written PID marker only when its line is complete. */
function pidMarker(value: string, file = '"$0"') {
  return `echo "${value}" > ${file}.tmp && mv ${file}.tmp ${file}`;
}

for (const value of ["$$", "$$ $$"])
  test(`a PID marker is hidden until its write finishes (${value})`, async () => {
    const out = await mkdtemp(join(temp, "pid-publication-"));
    const file = join(out, "agent.pid");
    // Redirection has opened the file before this echo function runs. Pause at
    // that exact point, then let the reader inspect it before releasing the write.
    const writer = Bun.spawn(
      [
        "sh",
        "-c",
        `echo() { printf 'opened\n' >&2; read -r release; printf '%s\n' "$*"; }; ${pidMarker(value)}`,
        file,
      ],
      { stdin: "pipe", stdout: "ignore", stderr: "pipe" },
    );
    const ready = writer.stderr.getReader();
    try {
      const { value: bytes } = await ready.read();
      expect(new TextDecoder().decode(bytes)).toBe("opened\n");
      const exposed = (await Bun.file(file).exists()) ? await readFile(file, "utf8") : undefined;
      expect(exposed).toBeUndefined();
    } finally {
      await writer.stdin.write("release\n");
      await writer.stdin.end();
      await writer.exited;
      ready.releaseLock();
    }
    expect(writer.exitCode).toBe(0);
    const pids = (await readFile(file, "utf8")).trim().split(" ").map(Number);
    expect(pids).toHaveLength(value.split(" ").length);
    for (const pid of pids) expect(pid).toBeGreaterThan(0);
  });

// Run the real supervisor in a separate process so the injected ps cannot affect other tests.
for (const mode of ["leader exit", "SIGINT", "SIGINT finishing run"] as const)
  test(`a stalled member listing cannot hold cleanup after ${mode}`, async () => {
    const { app, out } = await appCopy();
    const gate = join(out, "release-listing");
    const listings = join(out, "listings");
    const agentPid = join(out, "agent.pid");
    const auth = join(out, "source-auth.json");
    await mkdir(listings);
    await writeFile(auth, "credentials");
    const listingScript = join(out, "listing.ts");
    await writeFile(
      listingScript,
      `await Bun.write(${JSON.stringify(listings)} + "/" + process.pid, "");
while (!(await Bun.file(${JSON.stringify(gate)}).exists())) await Bun.sleep(10);`,
    );
    const script = join(out, "stalled-runner.ts");
    const { setup: _, ...scenario } = withSetup("unused");
    await writeFile(
      script,
      `import {existsSync} from "node:fs";
import {run, runInApp} from ${JSON.stringify(resolve(import.meta.dir, "../scripts/skills-eval-scenario.ts"))};
const spawn = Bun.spawn.bind(Bun);
const kill = process.kill.bind(process);
const kills = new Map();
const active = () => ${JSON.stringify(mode)} === "leader exit" || existsSync(${JSON.stringify(agentPid)});
// Make even an already-killed group require a listing (as with an EPERM probe).
process.kill = (pid, signal) => {
 if (signal === 0 && active()) return true;
 if (pid < 0 && signal === "SIGKILL" && active()) {
  kills.set(pid, (kills.get(pid) ?? 0) + 1);
  if (${JSON.stringify(mode)} === "SIGINT finishing run" && kills.get(pid) > 1)
   throw Object.assign(new Error("kill ESRCH"), {code: "ESRCH"});
  try { kill(pid, signal); } catch {}
  throw Object.assign(new Error("kill EPERM"), {code: "EPERM"});
 }
 return kill(pid, signal);
};
Bun.spawn = (cmd, options) => spawn(cmd[0] === "ps" && active()
 ? [process.execPath, ${JSON.stringify(listingScript)}] : cmd, options);
${
  mode === "leader exit"
    ? `const result = await run(["sh", "-c", "sleep 60 & echo $!"], ${JSON.stringify(app)}, {cleanup: {goneMs: 50}});
console.log(JSON.stringify(result));`
    : `await runInApp({scenario: ${JSON.stringify(scenario)}, arm: "with", scenarioDir: ${JSON.stringify(temp)}, app: ${JSON.stringify(app)}, out: ${JSON.stringify(out)}, codexAuth: ${JSON.stringify(auth)}, agent: ["sh", "-c", ${JSON.stringify(pidMarker("$$") + "; sleep 60 & wait")}, ${JSON.stringify(agentPid)}]});`
}
`,
    );
    const runner = Bun.spawn([process.execPath, script], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = new Response(runner.stdout).text();
    const errors = new Response(runner.stderr).text();
    const waitFor = async (ready: () => Promise<boolean>) => {
      const deadline = performance.now() + 10_000;
      while (!(await ready()) && performance.now() < deadline) await Bun.sleep(10);
      expect(await ready()).toBe(true);
    };
    try {
      if (mode !== "leader exit") {
        await waitFor(() => Bun.file(agentPid).exists());
        runner.kill("SIGINT");
      }
      await waitFor(async () => (await readdir(listings)).length > 0);
      // The gate remains shut. Completion must come from the cleanup deadline, not ps EOF.
      const code = await Promise.race([
        runner.exited,
        Bun.sleep(mode === "leader exit" ? 1000 : 12_000).then(() => "listing still awaited"),
      ]);
      if (code === 1) throw new Error(await errors);
      expect(code).toBe(mode === "leader exit" ? 0 : 130);
      if (mode === "leader exit") {
        const result = z
          .object({
            code: z.number(),
            output: z.string(),
            timedOut: z.boolean(),
            left: z.number(),
          })
          .parse(JSON.parse(await output));
        expect(result).toMatchObject({ code: 0, timedOut: false, left: 1 });
        expect(alive(pidOf(result.output))).toBe(false);
      } else {
        expect(await readdir(runLayout(out).codex)).toEqual([]);
        expect(alive(Number(await readFile(agentPid, "utf8")))).toBe(false);
      }
      for (const pid of await readdir(listings)) expect(await running(Number(pid))).toBe(false);
      expect(await errors).toBe("");
    } finally {
      await writeFile(gate, "release");
      // Release the diagnostic listing even on the old implementation, then reap the runner.
      runner.kill("SIGKILL");
      await runner.exited;
      for (const pid of await readdir(listings))
        if (alive(Number(pid))) process.kill(Number(pid), "SIGKILL");
      await Promise.all([output, errors]);
    }
  }, 20_000);

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
    arm: "with",
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
    arm: "with",
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
    arm: "with",
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
    "| luciole-x/planted | with | 1   |    |    | -          | -            | -             | setup failed | 0s       |",
  );
});

test("a scenario without setup runs the agent on the app as copied", async () => {
  const { out, app } = await appCopy();
  const { setup: _, ...scenario } = withSetup("unused");
  const result = await runInApp({
    scenario,
    arm: "with",
    scenarioDir: temp,
    app,
    out,
    agent: WRITES_FILE,
  });
  expect(result).toMatchObject({ agent: "ok", checks: [false, true] });
  expect(await Bun.file(join(out, "setup.log")).exists()).toBe(false);
});

test("while the agent runs, its root holds only its app, its $TMPDIR and its $CODEX_HOME", async () => {
  const { out, app } = await appCopy();
  const { tmp, codex } = runLayout(out);
  expect(runLayout(out).app).toBe(app);
  const auth = join(await mkdtemp(join(temp, "codex-home-")), "auth.json");
  await writeFile(auth, '{"token":"t"}\n');
  const result = await runInApp({
    scenario: withSetup("echo planted > planted.txt"),
    arm: "without",
    scenarioDir: await scenarioDir(),
    app,
    out,
    codexAuth: auth,
    agent: [
      "sh",
      "-c",
      'ls -A ..; ls -A "$CODEX_HOME"; echo "TMPDIR=$TMPDIR CODEX_HOME=$CODEX_HOME"; echo agent > agent.txt',
    ],
  });
  expect(result).toMatchObject({ agent: "ok", checks: [true, true] });
  // The setup's log, like the transcript, is written once the agent has ended.
  expect(await readFile(join(out, "transcript.jsonl"), "utf8")).toBe(
    `app\ncodex\ntmp\nauth.json\nTMPDIR=${tmp} CODEX_HOME=${codex}\n`,
  );
  expect(await readFile(join(out, "setup.log"), "utf8")).toBe("exit 0\n");
  // The credentials leave with the agent; the user's own stay where they were.
  expect(await readdir(codex)).toEqual([]);
  expect(await readFile(auth, "utf8")).toBe('{"token":"t"}\n');
});

test("a failing agent spawn removes the auth copy and its signal handlers", async () => {
  const { out, app } = await appCopy();
  const auth = join(await mkdtemp(join(temp, "auth-")), "auth.json");
  await writeFile(auth, "credentials");
  const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  const { setup: _, ...scenario } = withSetup("unused");
  const error = await rejectionOf(
    runInApp({
      scenario,
      arm: "with",
      scenarioDir: temp,
      app,
      out,
      codexAuth: auth,
      agent: [join(temp, "missing-agent")],
    }),
  );
  expect(error).toBeInstanceOf(Error);
  expect(await readdir(runLayout(out).codex)).toEqual([]);
  expect(await readFile(auth, "utf8")).toBe("credentials");
  expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(listeners);
});

test("an agent timeout removes the auth copy", async () => {
  const { out, app } = await appCopy();
  const auth = join(await mkdtemp(join(temp, "auth-")), "auth.json");
  await writeFile(auth, "credentials");
  const { setup: _, ...scenario } = withSetup("unused");
  const result = await runInApp({
    scenario: { ...scenario, timeoutMinutes: 0.001 },
    arm: "with",
    scenarioDir: temp,
    app,
    out,
    codexAuth: auth,
    agent: ["sleep", "30"],
  });
  expect(result.agent).toBe("timeout");
  expect(await readdir(runLayout(out).codex)).toEqual([]);
});

for (const signal of ["SIGINT", "SIGTERM"] as const)
  for (const fileAuth of [true, false])
    test(`${signal} ends concurrent agent groups and removes auth copies (file auth: ${fileAuth})`, async () => {
      const auth = join(await mkdtemp(join(temp, "auth-")), "auth.json");
      await writeFile(auth, "credentials");
      const runs = await Promise.all([appCopy(), appCopy()]);
      const pidFiles = runs.map(({ out }) => join(out, "agent.pid"));
      const script = join(runs[0].out, "runner.ts");
      const store = await mkdtemp(join(temp, "signal-store-"));
      const { setup: _, ...scenario } = withSetup("unused");
      await writeFile(
        script,
        `import { runInApp, withStoredRun, copyApp, runLayout } from ${JSON.stringify(resolve(import.meta.dir, "../scripts/skills-eval-scenario.ts"))};
await Promise.all(${JSON.stringify(
          runs.map(({ out, app }, n) => ({
            scenario,
            arm: "with",
            scenarioDir: temp,
            app,
            out,
            codexAuth: fileAuth ? auth : undefined,
            // Bounded children expire on their own if the assertion fails. The test never
            // ends these groups itself: only the runner's interrupt path may do that.
            agent: ["sh", "-c", `sleep 10 & ${pidMarker("$$ $!")}; wait`, pidFiles[n]],
          })),
        )}.map(options => withStoredRun(${JSON.stringify(store)}, [], async root => {
 const {app} = runLayout(root);
 await copyApp(options.app, app, root);
 await Bun.write(options.out + "/store-root", root);
 await runInApp({...options, app, runRoot: root});
})));
`,
      );
      const runner = Bun.spawn([process.execPath, script], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      });
      try {
        // Both markers prove both agents are running before signalling their owner.
        const deadline = performance.now() + 10_000;
        while (
          !(await Promise.all(pidFiles.map((file) => Bun.file(file).exists()))).every(Boolean) &&
          performance.now() < deadline
        )
          await Bun.sleep(10);
        const groups = await Promise.all(
          pidFiles.map(async (file) =>
            (await readFile(file, "utf8")).trim().split(" ").map(Number),
          ),
        );
        const storeRoots = await Promise.all(
          runs.map(({ out }) => readFile(join(out, "store-root"), "utf8")),
        );
        for (const root of storeRoots)
          expect(await Bun.file(join(runLayout(root).codex, "auth.json")).exists()).toBe(fileAuth);
        runner.kill(signal);
        runner.kill(signal);
        expect(await runner.exited).toBe(signal === "SIGINT" ? 130 : 143);
        for (const [leader, child] of groups) {
          expect(leader).toBeGreaterThan(0);
          expect(child).toBeGreaterThan(0);
          expect(alive(-leader)).toBe(false);
          expect(alive(child)).toBe(false);
        }
        for (const root of storeRoots) expect(existsSync(root)).toBe(false);
        expect(await readdir(store)).toEqual([]);
        expect(await readFile(auth, "utf8")).toBe("credentials");
      } finally {
        runner.kill("SIGKILL");
        await runner.exited;
      }
    }, 20_000);

test("an interrupt during report checks ends the check group and removes its live store", async () => {
  const source = await appCopy();
  const out = await mkdtemp(join(temp, "checking-report-"));
  const store = await mkdtemp(join(temp, "checking-store-"));
  const pidFile = join(out, "check.pid");
  const marker = join(out, "store-root");
  const script = join(out, "runner.ts");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(
    script,
    `import {withStoredRun, copyApp, runInApp, runLayout} from ${JSON.stringify(resolve(import.meta.dir, "../scripts/skills-eval-scenario.ts"))};
await withStoredRun(${JSON.stringify(store)}, [], async root => {
 const {app} = runLayout(root);
 await copyApp(${JSON.stringify(source.app)}, app, root);
 await Bun.write(${JSON.stringify(marker)}, root);
 await runInApp({...${JSON.stringify({
   scenario: {
     name: "s/checking",
     prompt: "p",
     timeoutMinutes: 1,
     checks: [{ run: `sleep 10 & ${pidMarker("$$ $!", quote(pidFile))}; wait` }],
   },
   arm: "without",
   scenarioDir: temp,
   out,
   agent: ["sh", "-c", "true"],
 })}, app, runRoot: root});
});
`,
  );
  const runner = Bun.spawn([process.execPath, script], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    const deadline = performance.now() + 10_000;
    while (!(await Bun.file(pidFile).exists()) && performance.now() < deadline) await Bun.sleep(10);
    const [leader, child] = (await readFile(pidFile, "utf8")).trim().split(" ").map(Number);
    const root = await readFile(marker, "utf8");
    expect(leader).toBeGreaterThan(0);
    expect(child).toBeGreaterThan(0);
    runner.kill("SIGTERM");
    runner.kill("SIGTERM");
    expect(await runner.exited).toBe(143);
    expect(alive(-leader)).toBe(false);
    expect(alive(child)).toBe(false);
    expect(existsSync(root)).toBe(false);
    expect(await readdir(store)).toEqual([]);
  } finally {
    runner.kill("SIGKILL");
    await runner.exited;
  }
}, 20_000);

test("without an auth file, each fresh home starts empty and the pass continues", async () => {
  const home = await mkdtemp(join(temp, "empty-home-"));
  const codexAuth = await codexAuthIn(home);
  expect(codexAuth).toBeUndefined();
  const { setup: _, ...scenario } = withSetup("unused");
  const report = join(home, "report.md");
  const results = await runPass(
    [1, 2],
    async (n) => {
      const { out, app } = await appCopy();
      const result = await runInApp({
        scenario,
        arm: "with",
        scenarioDir: temp,
        app,
        out,
        codexAuth,
        agent: ["sh", "-c", 'ls -A "$CODEX_HOME"; echo agent > agent.txt'],
      });
      expect(await readFile(join(out, "transcript.jsonl"), "utf8")).toBe("");
      return { scenario: scenario.name, arm: "with" as const, run: n, ...result };
    },
    { scenarios: [scenario], report },
  );
  expect(results.map(({ agent }) => agent)).toEqual(["ok", "ok"]);
  expect(await readFile(report, "utf8")).toContain("| 2");
  const auth = join(home, "auth.json");
  await writeFile(auth, "credentials");
  expect(await codexAuthIn(home)).toBe(auth);
});

test("the report flags a without run that read the material, and a write outside the app", async () => {
  const scenario: Scenario = {
    name: "luciole-x/leaky",
    prompt: "p",
    checks: [{ exists: "a.txt" }],
    timeoutMinutes: 1,
  };
  const read = ran("cat ../../with-1/app/.agents/skills/luciole-x/SKILL.md", 0);
  const reference = "# Reference\n\nRead the full routing rules.";
  const fingerprint = referenceFingerprintOf(reference);
  if (!fingerprint) throw new Error("Reference fixture needs an opening");
  const referenceRead = ran("cat renamed.txt", 0, reference);
  const results: RunResult[] = [];
  const escaped: string[] = [];
  for (const arm of ["without", "with"] as const) {
    const { out, app } = await appCopy();
    const outside = join(out, "LoginForm.tsx");
    escaped.push(outside);
    const transcript = [
      read,
      referenceRead,
      changed("completed", join(app, "a.txt"), outside),
    ].join("\n");
    const agent = ["sh", "-c", `printf '%s\\n' "$0"`, transcript];
    const result = await runInApp({
      scenario,
      arm,
      scenarioDir: temp,
      app,
      out,
      agent,
      references: [fingerprint],
    });
    results.push({ scenario: scenario.name, arm, run: 1, ...result });
  }
  const command = "/bin/zsh -lc 'cat ../../with-1/app/.agents/skills/luciole-x/SKILL.md'";
  expect(results.map(({ contamination, outside }) => ({ contamination, outside }))).toEqual([
    { contamination: [command, "/bin/zsh -lc 'cat renamed.txt'"], outside: [escaped[0]] },
    { contamination: undefined, outside: [escaped[1]] },
  ]);
  const table = renderTable(results, [scenario]).split("\n");
  expect(table[2]).toMatch(
    /^\| luciole-x\/leaky \| without \| 1 +\| pass \| - +\| YES +\| YES +\|/,
  );
  expect(table[3]).toMatch(/^\| luciole-x\/leaky \| with +\| 1 +\| pass \| - +\| - +\| YES +\|/);
  expect(table.slice(-7)).toEqual([
    "Contaminated (the material read in the without arm):",
    `  luciole-x/leaky without 1: ${command}`,
    "  luciole-x/leaky without 1: /bin/zsh -lc 'cat renamed.txt'",
    "",
    "Written outside the app:",
    `  luciole-x/leaky without 1: ${escaped[0]}`,
    `  luciole-x/leaky with 1: ${escaped[1]}`,
  ]);
});

test("stored runs deny canonical entries when the store is reached through a symlink", async () => {
  const store = await mkdtemp(join(temp, "symlink-store-"));
  const other = join(store, "other-run");
  await mkdir(other);
  const linkedStore = `${store}-link`;
  await symlink(store, linkedStore);
  await withStoredRun(linkedStore, [], async (root) => {
    const expected = [realpathSync(other), runLayout(root).codex].sort();
    expect(await deniedStoreEntries(linkedStore, root)).toEqual(expected);
    expect(await deniedStoreEntries(realpathSync(store), root)).toEqual(expected);
  });
});

test("stored runs deny other entries and return app, logs and checks to the report", async () => {
  expect(runStoreIn("/home/u")).toBe("/home/u/.cache/luciole-skills-eval");
  expect(runStoreIn("/home/u", "/cache")).toBe("/cache/luciole-skills-eval");
  const store = await mkdtemp(join(temp, "store-"));
  const other = join(store, "other-run");
  await mkdir(other);
  const source = await appCopy();
  const out = join(temp, "stored-report");
  await mkdir(out);
  let runRoot = "";
  const result = await withStoredRun(store, [], async (root) => {
    runRoot = root;
    const { app, tmp: runTmp, codex } = runLayout(root);
    await copyApp(source.app, app, root);
    const denies = await deniedStoreEntries(store, root);
    expect(denies).toEqual([realpathSync(other), codex].sort());
    const command = agentCommand({
      app,
      tmp: runTmp,
      model: "m",
      prompt: "p",
      unreadable: denies,
    });
    expect(command[7]).toBe(app);
    expect(command).toContain(
      `permissions.skills_eval.filesystem={ "/" = "read", ${denies.map((path) => `"${path}" = "deny"`).join(", ")}, "${runTmp}" = "write", ":workspace_roots" = { "." = "write", ".agents" = "write", ".git" = "write" } }`,
    );
    const result = await runInApp({
      scenario: {
        name: "s/stored",
        prompt: "p",
        timeoutMinutes: 1,
        checks: [{ exists: "agent.txt" }],
      },
      arm: "without",
      scenarioDir: temp,
      app,
      out,
      runRoot: root,
      agent: [
        "sh",
        "-c",
        'echo changed > agent.txt; mkdir "$CODEX_HOME/sessions"; echo session > "$CODEX_HOME/sessions/session.log"; echo "$TMPDIR"',
      ],
    });
    expect((await readdir(root)).toSorted()).toEqual(["app", "codex", "tmp"]);
    expect(await readFile(join(out, "transcript.jsonl"), "utf8")).toBe(`${runTmp}\n`);
    expect(await readFile(join(out, "codex/sessions/session.log"), "utf8")).toBe("session\n");
    expect(await Bun.file(join(codex, "auth.json")).exists()).toBe(false);
    return result;
  });
  expect(result).toMatchObject({ agent: "ok", checks: [true] });
  expect(await readFile(join(out, "app/agent.txt"), "utf8")).toBe("changed\n");
  expect(existsSync(runRoot)).toBe(false);
  expect(await readdir(store)).toEqual(["other-run"]);
  const error = await rejectionOf(withStoredRun(store, [temp], async () => undefined));
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain("outside every unreadable root");
});

test("a successful read of a late store entry contaminates only the other run", () => {
  const store = {
    directory: "/cache/store",
    root: "/cache/store/own",
    app: "/cache/store/own/app",
  };
  const transcript = [
    ran("cat /cache/store/late/app/file", 0),
    ran("cat ../../late/app/file", 0),
    ran("cat /cache/store/own/app/file", 0),
    ran("ls ../..", 0),
    ran("cat /cache/store/late/app/file", 1),
  ].join("\n");
  expect(materialReads(transcript, { skill: "luciole-app", store })).toEqual([
    "/bin/zsh -lc 'cat /cache/store/late/app/file'",
    "/bin/zsh -lc 'cat ../../late/app/file'",
  ]);
});

test("the agent argv pins filesystem isolation and the loopback-only proxy allowlist", () => {
  const command = agentCommand({
    app: "/r/runs/s/without-1/app",
    tmp: "/r/runs/s/without-1/tmp",
    model: "m",
    prompt: "Do it.",
    unreadable: ["/var/T", "/w"],
  });
  expect(command).not.toContain("--sandbox");
  expect(command.slice(0, 8)).toEqual([
    "codex",
    "exec",
    "-m",
    "m",
    "--skip-git-repo-check",
    "--json",
    "-C",
    "/r/runs/s/without-1/app",
  ]);
  expect(command.slice(8)).toEqual([
    "-c",
    'default_permissions="skills_eval"',
    "-c",
    "permissions.skills_eval.filesystem={ " +
      '"/" = "read", "/var/T" = "deny", "/w" = "deny", "/r/runs/s/without-1/tmp" = "write", ' +
      '":workspace_roots" = { "." = "write", ".agents" = "write", ".git" = "write" } }',
    "-c",
    "features.network_proxy=true",
    "-c",
    "permissions.skills_eval.network={ enabled = true, allow_local_binding = true, " +
      'domains = { "localhost" = "allow", "127.0.0.1" = "allow", "::1" = "allow" } }',
    "Do it.",
  ]);
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
    arm: "with",
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
    arm: "with",
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
    "| luciole-x/pass | without | 1   | pass | -          | -            | -             | ok    | 1s       |",
    "| luciole-x/pass | without | 2   | pass | -          | -            | -             | ok    | 1s       |",
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
