/**
 * Measures whether luciole's agent material helps a coding agent:
 *
 *   bun run skills:eval <skill> [<scenario>…] [--runs N] [--model M]
 *
 * It packs @luciole-sh/core (its docs exist only after `prepack`) and the workspace packages a
 * starter needs, stages a starter whose dependencies are those tarballs, and installs it. Each
 * scenario of evals/skills/<skill>/ (all of them, or those named) then runs with Codex in a copy
 * of that app, once per arm and run:
 * - without: no `.agents/skills`, no AGENTS.md block, and neither the skills nor the block in
 *   node_modules/@luciole-sh/core, only its docs;
 * - with: after `luciole skills install --agent agents`.
 * Each run's agent writes only in its root's app and tmp (its `$TMPDIR`) and reads neither the
 * other runs, the report, other temporary directories nor the repository; the without arm's
 * agent reads the skill under test and the AGENTS.md block nowhere on the disk.
 * The scenario's checks run in the copy afterwards. The table, the transcripts and the diffs are
 * the report; it exits 0 whatever the scores, because it measures and does not gate. It runs
 * one scenario at a time and is never part of `bun test` or `bun run verify`.
 */
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { stageStarter } from "../packages/create/scripts/starter";
import {
  agentCommand,
  commitAll,
  copyApp,
  deniedStoreEntries,
  runStoreIn,
  withStoredRun,
  codexAuthIn,
  fingerprintOf,
  referencePolicy,
  must,
  parseArgs,
  parseScenario,
  renderTable,
  run,
  runInApp,
  runLayout,
  runPass,
  skillOf,
  splitBases,
  unreadableFor,
  USAGE,
  type Arm,
  type Args,
  type Fingerprint,
  type RunResult,
  type Scenario,
} from "./skills-eval-scenario";

const workspace = resolve(import.meta.dir, "..");
/** The user's Codex home: its credentials start each run, and no run may read the rest. */
const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const SCENARIOS = join(workspace, "evals/skills");
/** The workspace packages a starter depends on, which the registry may not have at this version. */
const PACKED = {
  "@luciole-sh/core": "packages/core",
  "@luciole-sh/markdown-editor": "packages/markdown-editor",
};
const ARMS: readonly Arm[] = ["without", "with"];
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
 * The directories no run may read: the temporary directories, which hold this report with its
 * bases, tarballs and runs, the reports of other passes, and the apps agents made for
 * themselves; the user's Codex home, whose sessions' logs, history and memories hold what every
 * earlier session read, this pass's runs included; and every checkout of this repository, which
 * holds the skills' sources. Live roots sit outside those ancestors; other store entries
 * are denied separately.
 */
async function unreadableRoots(): Promise<string[]> {
  const roots = [tmpdir(), "/tmp", codexHome];
  if (process.platform === "darwin") {
    const user = (await run(["getconf", "DARWIN_USER_TEMP_DIR"], workspace)).output.trim();
    if (user) roots.push(user);
  }
  const worktrees = await must(["git", "worktree", "list", "--porcelain"], workspace);
  for (const line of worktrees.split("\n"))
    if (line.startsWith("worktree ")) roots.push(line.slice("worktree ".length));
  return [...new Set(roots)];
}

/** A git repository at `directory` whose one commit is the app as the agent finds it. */
async function baseline(directory: string) {
  await must(["git", "init", "-q"], directory);
  await commitAll(directory, "baseline");
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
  await splitBases({
    without,
    with: withMaterial,
    copy: copyApp,
    install: async (app) => {
      await must(
        [join(app, "node_modules/.bin/luciole"), "skills", "install", "--agent", "agents"],
        app,
      );
    },
  });
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
  unreadable: readonly string[];
  fingerprint?: Fingerprint;
  references: Awaited<ReturnType<typeof referencePolicy>>;
}): Promise<RunResult> {
  const { scenario, arm, base, out, model } = options;
  await mkdir(out, { recursive: true });
  const store = runStoreIn(homedir(), process.env.XDG_CACHE_HOME);
  return withStoredRun(store, options.unreadable, async (root) => {
    const { app, tmp } = runLayout(root);
    await copyApp(base, app, root);
    const otherRuns = await deniedStoreEntries(dirname(root), root);
    console.log(`${scenario.name} · ${arm} · run ${options.run}: codex in ${app}`);
    const result = await runInApp({
      scenario,
      arm,
      scenarioDir: join(SCENARIOS, dirname(scenario.name)),
      app,
      out,
      runRoot: root,
      agent: agentCommand({
        app,
        tmp,
        model,
        prompt: scenario.prompt,
        unreadable: unreadableFor({
          arm,
          skill: skillOf(scenario),
          roots: [...options.unreadable, ...otherRuns],
          references: options.references.denies,
        }),
      }),
      codexAuth: await codexAuthIn(codexHome),
      fingerprint: options.fingerprint,
      references: options.references.fingerprints,
    });
    return { scenario: scenario.name, arm, run: options.run, ...result };
  });
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
  const unreadable = await unreadableRoots();
  // The skill as the with arm installs it: its text, wherever a without agent finds a copy.
  const fingerprint = fingerprintOf(
    await readFile(join(bases.with, ".agents/skills", args.skill, "SKILL.md"), "utf8").catch(
      () => "",
    ),
  );

  const references = await referencePolicy(
    join(bases.with, ".agents/skills", args.skill),
    bases.without,
  );

  const plan = scenarios.flatMap((scenario) =>
    Array.from({ length: args.runs }, (_, i) => i + 1).flatMap((n) =>
      ARMS.map((arm) => ({ scenario, arm, n })),
    ),
  );
  const results = await runPass(
    plan,
    ({ scenario, arm, n }) =>
      runOnce({
        scenario,
        arm,
        run: n,
        base: bases[arm],
        out: join(temp, "runs", scenario.name, `${arm}-${n}`),
        model: args.model,
        unreadable,
        fingerprint,
        references,
      }),
    { scenarios, report: join(temp, "report.md") },
  );

  const table = renderTable(results, scenarios);
  console.log(`\n${table}\n`);
  console.log(`Transcripts, diffs and check logs: ${join(temp, "runs")}`);
}

await main();
