import { readdirSync, readFileSync } from "node:fs";

// What a change needs checked while it is being made: every project's types, the lint and
// the format (seconds), then only the tests the change can reach. `bun run verify` stays
// the complete check, once, before merging.
//
// Usage: bun run verify:fast [base]   (base: the branch the change started from, `main`)
//
// The tests: `bun test --changed` follows static imports from the files changed since the
// merge base (committed, staged, unstaged, untracked). What it cannot see is added:
// - a change under `examples/<app>/` reaches the tests that name `examples/<app>`, since
//   they build or launch the app by its path;
// - a change to the CLI reaches the tests that spawn `cli.ts`;
// - a change to what every test stands on (package manifests, lockfile, TypeScript or Bun
//   configuration, the tests' shared helpers and fixtures) runs the whole suite.
const base = process.argv[2] ?? "main";
const SHORT_SHA = 7;
const TEST_FLAGS = ["--timeout", "20000", "--parallel=4"];
const EVERYTHING = [
  /(^|\/)package\.json$/,
  /^bun\.lock$/,
  /^bunfig\.toml$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /^tests\/[^/]*helpers\.tsx?$/,
  /^tests\/[^/]*-server\.tsx?$/,
  /^tests\/fixtures\//,
];
const CLI = /^packages\/core\/src\/(cli\.ts|commands\/)/;
const TEST_FILE = /^tests\/.*\.test\.tsx?$/;

function git(...args: string[]) {
  const run = Bun.spawnSync(["git", ...args], { stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
}
const lines = (text: string) => text.split("\n").filter(Boolean);

async function run(name: string, command: string[]) {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { name, code, output: (out + err).trim() };
}

/** The test files `bun test --changed` would run: a run that matches no test lists them. */
async function staticallyReached(since: string) {
  const report = `${process.env.TMPDIR ?? "/tmp"}/verify-fast-${process.pid}.xml`;
  await run("select", [
    process.execPath,
    "test",
    `--changed=${since}`,
    "--test-name-pattern",
    "^ verify-fast selects, runs nothing $",
    "--reporter=junit",
    `--reporter-outfile=${report}`,
  ]);
  const xml = await Bun.file(report)
    .text()
    .catch(() => "");
  await Bun.file(report)
    .delete()
    .catch(() => {});
  return [...xml.matchAll(/<testsuite name="([^"]+\.test\.tsx?)"/g)].map((m) => m[1] ?? "");
}

const since = git("merge-base", "HEAD", base);
const changed = [
  ...new Set([
    ...lines(git("diff", "--name-only", since)),
    ...lines(git("ls-files", "--others", "--exclude-standard")),
  ]),
];

const tests = readdirSync("tests").filter((name) => /\.test\.tsx?$/.test(name));
const mentioning = (needle: string) =>
  tests
    .filter((name) => readFileSync(`tests/${name}`, "utf8").includes(needle))
    .map((name) => `tests/${name}`);

const whole = changed.find((path) => EVERYTHING.some((pattern) => pattern.test(path)));
let selected: string[] = [];
if (!whole) {
  const dynamic = new Set<string>();
  for (const path of changed) {
    const app = /^examples\/([^/]+)\//.exec(path)?.[1];
    if (app) for (const test of mentioning(`examples/${app}`)) dynamic.add(test);
    if (CLI.test(path)) for (const test of mentioning("cli.ts")) dynamic.add(test);
    if (TEST_FILE.test(path)) dynamic.add(path);
  }
  const reached = await staticallyReached(since);
  selected = [...new Set([...reached, ...dynamic])].filter((test) =>
    tests.includes(test.replace(/^tests\//, "")),
  );
}

console.log(
  `verify:fast: ${changed.length} file(s) changed since ${base} (${since.slice(0, SHORT_SHA)}); ` +
    (whole
      ? `${whole} changed: the whole suite runs`
      : `${selected.length} test file(s) reach them`),
);

const checks = await Promise.all([
  run("check", [process.execPath, "run", "check"]),
  run("lint", [process.execPath, "run", "lint"]),
  run("format:check", [process.execPath, "run", "format:check"]),
]);
for (const { name, code, output } of checks)
  console.log(code === 0 ? `✓ ${name}` : `✗ ${name} (exit ${code})\n${output}`);
if (checks.some(({ code }) => code !== 0)) process.exit(1);

if (!whole && selected.length === 0) {
  console.log("✓ tests: none reaches this change");
  process.exit(0);
}
// `./`: bun test takes a bare argument as a filter on paths, a `./` one as the file.
const files = selected.map((test) => `./${test}`);
const suite = Bun.spawn([process.execPath, "test", ...TEST_FLAGS, ...files], {
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await suite.exited);
