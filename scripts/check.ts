import { dirname, join } from "node:path";

// Type-checks every TypeScript project of the repository with TypeScript 7, all
// at once: the projects are independent (no project references).
//
// `node_modules/.bin/tsc` is not used: `@typescript/typescript6` (the AST API the
// build needs) brings `@typescript/old`, whose `tsc` wins that link, so a bare
// `tsc` runs the TypeScript 6 checker, 5 to 10 times slower.
const projects = [
  ".",
  "packages/luciole",
  "packages/luciole/src/devtools/luciole-devtools",
  "packages/luciole/src/launcher/luciole",
  "packages/luciole/src/generic/browser",
  "packages/luciole/src/web",
  "packages/harness",
  "examples/notes",
  "examples/latency",
  "examples/forge",
  "examples/files",
  "examples/mdreader",
  "examples/chat",
  "examples/agent",
  "examples/mux",
  "examples/coder",
  "examples/studio",
  "examples/studio/template",
];
const MS_PER_SECOND = 1000;

const tsc = join(dirname(Bun.resolveSync("typescript/package.json", process.cwd())), "bin/tsc");
const started = performance.now();
const results = await Promise.all(
  projects.map(async (project) => {
    const child = Bun.spawn([process.execPath, tsc, "--noEmit", "-p", project], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { project, code, output: (out + err).trim() };
  }),
);

const failed = results.filter((result) => result.code !== 0);
for (const { project, code, output } of failed)
  console.error(`\n── tsc -p ${project} (exit ${code})\n${output}`);
const seconds = ((performance.now() - started) / MS_PER_SECOND).toFixed(1);
console.log(
  `check: ${projects.length - failed.length}/${projects.length} projects type-check (TypeScript 7, ${seconds} s)`,
);
if (failed.length > 0) process.exit(1);
