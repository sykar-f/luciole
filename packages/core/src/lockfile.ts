import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { z } from "zod";

/**
 * The bun.lock that governs the installation `directory` belongs to: the nearest one at
 * or above it, not past the enclosing git checkout. It lists every platform's packages,
 * so the same sources hash the same on every machine that builds them: a Linux Server
 * and a macOS Client of one release keep one build id.
 *
 * The framework itself resolves to its own checkout, to the workspace root that holds
 * it, or to the application that installed it (`node_modules/@luciole-sh/core` walks up to the
 * app's lock): each is the installation its packages come from.
 */
export function governingLock(directory: string): string | undefined {
  for (let current = directory; ; current = dirname(current)) {
    const lock = join(current, "bun.lock");
    if (existsSync(lock)) return lock;
    if (existsSync(join(current, ".git")) || current === dirname(current)) return undefined;
  }
}

const Manifest = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
});

/**
 * The packages `app` depends on that are linked, not installed: a workspace's own
 * packages (`workspace:*`), whose real directory is outside every `node_modules`. The
 * lock does not change when their sources do, so the build hashes those sources and
 * `luciole dev` watches them. Their directories, deduplicated; luciole itself aside.
 */
export function linkedPackages(app: string): string[] {
  let manifest: z.infer<typeof Manifest>;
  try {
    manifest = Manifest.parse(JSON.parse(readFileSync(join(app, "package.json"), "utf8")));
  } catch {
    return [];
  }
  // The framework is part of every build already, by its own rules.
  const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter(
    (name) => name !== "@luciole-sh/core",
  );
  const found = new Set<string>();
  for (const name of names) {
    const installed = installedAt(app, name);
    if (!installed) continue;
    const real = realpathSync(installed);
    if (!real.split(sep).includes("node_modules")) found.add(real);
  }
  return [...found].sort();
}

/** Where `name` is installed for `from`: the nearest `node_modules/<name>` above it. */
function installedAt(from: string, name: string) {
  for (let current = from; ; current = dirname(current)) {
    const candidate = join(current, "node_modules", name);
    if (existsSync(candidate)) return candidate;
    if (current === dirname(current)) return undefined;
  }
}

/** A linked package's sources, as the build hashes them: not its dependencies nor its output. */
export const LINKED_SOURCES = "**/*.{ts,tsx,js,jsx,mjs,cjs,json,css,scm}";
export const isLinkedSource = (file: string) =>
  !/(^|[/\\])(node_modules|dist|\.luciole|\.git)([/\\]|$)/.test(file);
