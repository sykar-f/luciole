/** Private sources and output: another journey may publish the workspace example. */
import { cpSync, symlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { ROOT, example, temporaryDirectory } from "../pty/harness";

/** Build the real example outside the workspace, resolving its workspace packages. */
export function privateExample(name: string, prefix: string) {
  const directory = temporaryDirectory(prefix);
  try {
    const app = join(directory.path, name);
    cpSync(example(name), app, {
      recursive: true,
      filter: (source) => basename(source) !== ".luciole" && !basename(source).includes(".sqlite"),
    });
    symlinkSync(join(ROOT, "node_modules"), join(app, "node_modules"), "dir");
    return { ...directory, app };
  } catch (error) {
    directory[Symbol.dispose]();
    throw error;
  }
}
