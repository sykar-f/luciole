/**
 * Measures whether luciole's agent material helps a coding agent:
 *
 *   bun run skills:eval <skill> [<scenario>…] [--runs N] [--model M]
 *
 * It packs @luciole-sh/core (its docs exist only after `prepack`) and the workspace packages a
 * starter needs, stages a starter whose dependencies are those tarballs, and installs it. Each
 * scenario of evals/skills/<skill>/ (all of them, or those named) then runs with Codex in a copy
 * of that app, once per arm and run:
 * - without: no `.agents/skills` and no AGENTS.md block;
 * - with: after `luciole skills install --agent agents`.
 * The scenario's checks run in the copy afterwards. The table, the transcripts and the diffs are
 * the report; it exits 0 whatever the scores, because it measures and does not gate. It runs
 * one scenario at a time and is never part of `bun test` or `bun run verify`.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { stageStarter } from "../packages/create/scripts/starter";
import {
  describeCheck,
  must,
  parseArgs,
  parseScenario,
  readsSkill,
  renderTable,
  run,
  runCheck,
  USAGE,
  type Arm,
  type Args,
  type RunResult,
  type Scenario,
} from "./skills-eval-scenario";

const workspace = resolve(import.meta.dir, "..");
const SCENARIOS = join(workspace, "evals/skills");
/** The workspace packages a starter depends on, which the registry may not have at this version. */
const PACKED = {
  "@luciole-sh/core": "packages/core",
  "@luciole-sh/markdown-editor": "packages/markdown-editor",
};
const ARMS: readonly Arm[] = ["without", "with"];
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const PackageJson = z.looseObject({ dependencies: z.record(z.string(), z.string()) });

/** The scenarios to run: those named, or every one of the skill's. */
async function loadScenarios(args: Args): Promise<Scenario[]> {
  const directory = join(SCENARIOS, args.skill);
  const available = (await readdir(directory).catch((): string[] => []))
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.replace(/\.md$/, ""))
    .toSorted();
  if (!available.length) throw new Error(`no scenario in ${directory}`);
  const names = args.scenarios.length ? args.scenarios : available;
  for (const name of names)
    if (!available.includes(name))
      throw new Error(`${args.skill}/${name}: no such scenario (${available.join(", ")})`);
  return Promise.all(
    names.map(async (name) =>
      parseScenario(`${args.skill}/${name}`, await readFile(join(directory, `${name}.md`), "utf8")),
    ),
  );
}

/** `bun pm pack` of a workspace package into `destination` (`prepack` runs): the tarball. */
async function pack(directory: string, destination: string) {
  await mkdir(destination, { recursive: true });
  await must([process.execPath, "pm", "pack", "--destination", destination], directory);
  const [tarball] = (await readdir(destination)).filter((name) => name.endsWith(".tgz"));
  if (!tarball) throw new Error(`bun pm pack of ${directory} wrote no tarball`);
  return join(destination, tarball);
}

/**
 * A copy of `from` at `to`. On macOS, the system's `cp -c` clones: the copies share the
 * installation's blocks instead of writing node_modules again for every run. A `cp` earlier on
 * the PATH (GNU's, from Nix or Homebrew) has no `-c`, so the system's is named.
 */
async function copyApp(from: string, to: string) {
  if (process.platform === "darwin") {
    const cloned = await run(["/bin/cp", "-R", "-c", from, to], workspace);
    if (cloned.code === 0) return;
    await rm(to, { recursive: true, force: true });
  }
  await must(["cp", "-R", from, to], workspace);
}

/** A git repository at `directory` whose one commit is the app as the agent finds it. */
async function baseline(directory: string) {
  await must(["git", "init", "-q"], directory);
  await must(["git", "add", "-A"], directory);
  await must(
    [
      "git",
      "-c",
      "user.name=skills-eval",
      "-c",
      "user.email=skills-eval@luciole.invalid",
      "commit",
      "-q",
      "-m",
      "baseline",
    ],
    directory,
  );
}

/** The installed starter, and its copy with the agent material: one base per arm. */
async function prepareBases(temp: string): Promise<Record<Arm, string>> {
  console.log("Packing the workspace packages (prepack builds the docs)…");
  const tarballs: Record<string, string> = {};
  for (const [name, directory] of Object.entries(PACKED))
    tarballs[name] = await pack(join(workspace, directory), join(temp, "tarballs", directory));

  console.log("Staging and installing a starter…");
  const without = join(temp, "base", "without");
  await stageStarter({ workspace, target: without, link: "published" });
  const manifestFile = join(without, "package.json");
  const manifest = PackageJson.parse(JSON.parse(await readFile(manifestFile, "utf8")));
  for (const [name, tarball] of Object.entries(tarballs))
    manifest.dependencies[name] = `file:${tarball}`;
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2));
  await must([process.execPath, "install"], without);
  // Formatted as the starter's own check expects, so `bun run verify` fails only on the agent.
  await must([join(without, "node_modules/.bin/oxfmt"), "--write", "package.json"], without);

  const withMaterial = join(temp, "base", "with");
  await copyApp(without, withMaterial);
  await must(
    [join(withMaterial, "node_modules/.bin/luciole"), "skills", "install", "--agent", "agents"],
    withMaterial,
  );
  for (const directory of [without, withMaterial]) await baseline(directory);
  return { without, with: withMaterial };
}

async function runOnce(options: {
  scenario: Scenario;
  arm: Arm;
  run: number;
  base: string;
  out: string;
  model: string;
}): Promise<RunResult> {
  const { scenario, arm, base, out, model } = options;
  await mkdir(out, { recursive: true });
  const app = join(out, "app");
  await copyApp(base, app);
  console.log(`${scenario.name} · ${arm} · run ${options.run}: codex in ${app}`);

  const started = performance.now();
  const agent = await run(
    [
      "codex",
      "exec",
      "-m",
      model,
      "--skip-git-repo-check",
      "--json",
      "-C",
      app,
      "--sandbox",
      "workspace-write",
      scenario.prompt,
    ],
    app,
    { timeoutMs: scenario.timeoutMinutes * SECONDS_PER_MINUTE * MS_PER_SECOND },
  );
  const seconds = (performance.now() - started) / MS_PER_SECOND;
  await writeFile(join(out, "transcript.jsonl"), agent.output);

  await must(["git", "add", "-A"], app);
  await writeFile(
    join(out, "diff.patch"),
    await must(["git", "diff", "--cached", "--binary"], app),
  );

  const checks: boolean[] = [];
  const logs: string[] = [];
  for (const check of scenario.checks) {
    const result = await runCheck(check, app);
    checks.push(result.passed);
    logs.push(`## ${describeCheck(check)}: ${result.passed ? "pass" : "FAIL"}\n${result.log}`);
  }
  await writeFile(join(out, "checks.log"), logs.join("\n\n"));
  return {
    scenario: scenario.name,
    arm,
    run: options.run,
    checks,
    skillRead: scenario.expectSkill ? readsSkill(agent.output, scenario.expectSkill) : undefined,
    agent: agent.timedOut ? "timeout" : agent.code === 0 ? "ok" : `exit ${agent.code}`,
    seconds,
  };
}

async function main() {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error: unknown) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    process.exit(1);
  }
  const scenarios = await loadScenarios(args);
  const temp = await mkdtemp(join(tmpdir(), "luciole-skills-eval-"));
  console.log(`Report directory: ${temp}`);
  const bases = await prepareBases(temp);

  const results: RunResult[] = [];
  for (const scenario of scenarios)
    for (let n = 1; n <= args.runs; n++)
      for (const arm of ARMS) {
        const out = join(temp, "runs", scenario.name, `${arm}-${n}`);
        results.push(
          await runOnce({ scenario, arm, run: n, base: bases[arm], out, model: args.model }),
        );
      }

  const table = renderTable(results, scenarios);
  await writeFile(join(temp, "report.md"), `${table}\n`);
  console.log(`\n${table}\n`);
  console.log(`Transcripts, diffs and check logs: ${join(temp, "runs")}`);
}

await main();
