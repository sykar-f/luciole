import { afterAll } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { build, type BuildOptions } from "../build";

/** An app built for one test file, as `buildApp` returns it. */
export type BuiltApp = {
  /** The temporary directory holding the build and a link to the packages it resolves. */
  directory: string;
  /** The build's output (`<directory>/.luciole`): the Server runs from here. */
  output: string;
  /** The id of the build. */
  buildId: string;
};

/** The nearest `node_modules` at or above `directory`. */
function nodeModulesAbove(directory: string): string {
  for (let at = directory; ; at = dirname(at)) {
    const candidate = join(at, "node_modules");
    if (existsSync(candidate)) return candidate;
    if (dirname(at) === at) throw new Error(`No node_modules at or above ${directory}`);
  }
}

/**
 * Builds the app in `directory` (default: the working directory, an app's root under
 * `bun test`) for this test file alone, and removes the build after the file's tests.
 *
 * Call it at the top level of the test file, with `await`: the build runs while the file
 * loads, outside every test's timeout, in a temporary directory. Packages resolve through a
 * link to the app's `node_modules`. The app's own folder is left untouched, so a parallel
 * run, or a `luciole dev` running beside it, never shares an output.
 */
export async function buildApp(
  directory: string = process.cwd(),
  options?: BuildOptions,
): Promise<BuiltApp> {
  const source = resolve(directory);
  const temporary = await mkdtemp(join(tmpdir(), `luciole-test-${basename(source)}-`));
  afterAll(() => rm(temporary, { recursive: true, force: true }));
  await symlink(nodeModulesAbove(source), join(temporary, "node_modules"), "dir");
  const { buildId, output } = await build(source, join(temporary, ".luciole"), options);
  return { directory: temporary, output, buildId };
}
