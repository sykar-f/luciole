import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { runCommands } from "../website/src/lib/example-commands";
import { commands, packages } from "../website/src/lib/product";

const root = join(import.meta.dir, "..");

const Manifest = z.looseObject({ name: z.string(), private: z.boolean().optional() });

/** The packages a release publishes: those of packages/* not marked private (docs/RELEASING.md). */
const published = readdirSync(join(root, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(root, "packages", entry.name, "package.json"))
  .filter((path) => existsSync(path))
  .map((path) => Manifest.parse(JSON.parse(readFileSync(path, "utf8"))))
  .filter((manifest) => manifest.private === false)
  .map((manifest) => manifest.name);

/** `name` of `name@version`, scoped or not. */
const packageName = (spec: string) => spec.replace(/(?<=.)@[^/]*$/, "");

/**
 * What stops a printed command from running as written: `bun <file>` naming a file the
 * repository lacks, or `bunx <package>` fetching a package that is not ours.
 */
export function commandProblem(
  command: string,
  options: { exists: (path: string) => boolean; ours: readonly string[] },
): string | undefined {
  const [program, target = ""] = command.split(/\s+/);
  if (program === "bun" && /[/.]/.test(target) && !options.exists(target))
    return `${command}: ${target} does not exist`;
  if (program === "bunx" && !options.ours.includes(packageName(target)))
    return `${command}: ${target} is not one of our packages (${options.ours.join(", ")})`;
  return undefined;
}

const inRepository = { exists: (path: string) => existsSync(join(root, path)), ours: published };

test("a release publishes the five packages the documentation can name", () => {
  expect(published.toSorted()).toEqual([
    "@luciole-sh/core",
    "@luciole-sh/create",
    "@luciole-sh/flow-graph",
    "@luciole-sh/markdown-editor",
    "luciole.sh",
  ]);
});

test("the check refuses a missing file and a package that is not ours", () => {
  expect(commandProblem("bun packages/luciole/src/cli.ts", inRepository)).toContain(
    "does not exist",
  );
  expect(commandProblem("bunx luciole init my-app", inRepository)).toContain("not one of our");
  expect(commandProblem("bunx create-luciole", inRepository)).toContain("not one of our");
  expect(commandProblem("bunx @luciole-sh/create@0.1.0 my-app", inRepository)).toBeUndefined();
  expect(commandProblem("bun run dev", inRepository)).toBeUndefined();
  expect(commandProblem("luciole", inRepository)).toBeUndefined();
});

test("every command the site prints runs a file that exists or a package of ours", () => {
  const problems = Object.values(commands)
    .map((command) => commandProblem(command, inRepository))
    .filter(Boolean);
  expect(problems).toEqual([]);
});

test("every package the site names is published", () => {
  expect(Object.values(packages).filter((name) => !published.includes(name))).toEqual([]);
});

const examplesOnSite = Object.entries(runCommands).map(([key, example]) => ({ key, example }));

/** The example a `luciole example <name>` command runs, if it is one: `[ENV=… ]luciole example <name> …`. */
const exampleNamed = (command: string) => /\bluciole example (\S+)/.exec(command)?.[1];

test("every example the site runs with `luciole example` is a directory of examples/", () => {
  const named = examplesOnSite
    .map(({ example }) => exampleNamed(example.command))
    .filter((name) => name !== undefined);
  expect(named.length).toBeGreaterThan(0);
  expect(named.filter((name) => !existsSync(join(root, "examples", name)))).toEqual([]);
});

const RootManifest = z.looseObject({ scripts: z.record(z.string(), z.string()) });

test("every example the site lists runs from a clone: a script of the root or a file", () => {
  const { scripts } = RootManifest.parse(
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")),
  );
  const problems = examplesOnSite.flatMap(({ key, example }) => {
    const command = example.fromClone.replace(/^(\w+=\S+\s+)+/, "");
    const [program, verb, script] = command.split(/\s+/);
    if (program === "bun" && verb === "run")
      return script && script in scripts ? [] : [`${key}: the root has no script "${script}"`];
    const problem = commandProblem(command, inRepository);
    return problem ? [`${key}: ${problem}`] : [];
  });
  expect(problems).toEqual([]);
});

test("the README lists the examples of the site, but Forge", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const section = readme.slice(
    readme.indexOf("## Run an example"),
    readme.indexOf("## Read the documentation"),
  );
  const documented = [...section.matchAll(/^\| (?:`(\w+)`|DevTools)\s+\| `/gm)].map(
    (m) => m[1] ?? "devtools",
  );
  const onSite = examplesOnSite.map(({ key }) => key).filter((key) => key !== "forge");
  expect([...new Set(documented)].toSorted()).toEqual(onSite.toSorted());
  expect(readme).not.toMatch(/forge/i);
});
