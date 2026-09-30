import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The bun.lock that governs the installation `directory` belongs to: the nearest one at
 * or above it, not past the enclosing git checkout. It lists every platform's packages,
 * so the same sources hash the same on every machine that builds them: a Linux Server
 * and a macOS Client of one release keep one build id.
 *
 * The framework itself resolves to its own checkout, to the workspace root that holds
 * it, or to the application that installed it (`node_modules/luciole` walks up to the
 * app's lock): each is the installation its packages come from.
 */
export function governingLock(directory: string): string | undefined {
  for (let current = directory; ; current = dirname(current)) {
    const lock = join(current, "bun.lock");
    if (existsSync(lock)) return lock;
    if (existsSync(join(current, ".git")) || current === dirname(current)) return undefined;
  }
}
