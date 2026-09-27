import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { repo } from "../links";

// The files and directories a page cites, checked against the checkout at build time:
// a page cannot keep pointing at a file that moved.
const root = resolve(process.cwd(), existsSync(join(process.cwd(), "packages")) ? "." : "..");

/** The repository link of `path`, a file or a directory; a missing one fails the build. */
export function sourceLink(path: string): string {
  const file = join(root, path);
  if (!existsSync(file)) throw new Error(`Docs: ${path} is cited but does not exist.`);
  return `${repo}/${statSync(file).isDirectory() ? "tree" : "blob"}/main/${path}`;
}
