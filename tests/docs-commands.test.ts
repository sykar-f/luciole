import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
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
