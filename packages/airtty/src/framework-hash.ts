/**
 * What identifies the framework a build was made with: its sources (TypeScript, the web
 * runtime's page and OpenTUI patch) and the lockfile that governs its packages. A cached
 * build made by another airtty is redone (src/launcher/git.ts, src/web-runtime.ts).
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { governingLock } from "./lockfile";

const frameworkDirectory = resolve(import.meta.dir, "..");
/** One pattern each: Bun's Glob matches nothing when a top-level `{…}` holds paths. */
const SOURCES = ["**/*.{ts,tsx}", "src/web/index.html", "web/*.patch"];
let hash: Promise<string> | undefined;

/** The framework's files that go into its hash, relative to its directory, sorted. */
export const frameworkFiles = () =>
  SOURCES.flatMap((pattern) => [
    ...new Bun.Glob(pattern).scanSync({ cwd: frameworkDirectory }),
  ]).sort();

export function frameworkHash() {
  hash ??= (async () => {
    const digest = createHash("sha256");
    for (const file of frameworkFiles())
      digest.update(file).update(await readFile(join(frameworkDirectory, file)));
    const lock = governingLock(frameworkDirectory);
    if (lock) digest.update(await readFile(lock));
    return digest.digest("hex");
  })();
  return hash;
}
