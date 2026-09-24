/**
 * A lock between processes of this user on one machine: `mkdir` is atomic everywhere.
 * The owner's pid is written inside; a lock whose owner died is taken over. Two waiters
 * could both see the same dead owner and take over within a few milliseconds of each
 * other: this protects a cache against concurrent launches, not against an attacker.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const POLL_MS = 100;
const DEFAULT_TIMEOUT_MS = 600_000;

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    return typeof e === "object" && e !== null && "code" in e && e.code === "EPERM";
  }
}

const isCode = (e: unknown, code: string) =>
  typeof e === "object" && e !== null && "code" in e && e.code === code;

/** Runs `task` while holding `path` (a directory that must not exist otherwise). */
export async function withLock<T>(
  path: string,
  task: () => Promise<T>,
  { timeoutMs = DEFAULT_TIMEOUT_MS, waiting }: { timeoutMs?: number; waiting?: () => void } = {},
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  let told = false;
  for (;;) {
    try {
      await mkdir(path);
      break;
    } catch (e: unknown) {
      if (!isCode(e, "EEXIST")) throw e;
    }
    const owner = Number(await readFile(join(path, "pid"), "utf8").catch(() => ""));
    // No pid yet: its owner is between mkdir and writeFile, or died there. Wait either way.
    if (Number.isInteger(owner) && owner > 0 && !alive(owner)) {
      await rm(path, { recursive: true, force: true });
      continue;
    }
    if (performance.now() > deadline) throw new Error(`${path} is locked by process ${owner}`);
    if (!told) waiting?.();
    told = true;
    await Bun.sleep(POLL_MS);
  }
  try {
    await writeFile(join(path, "pid"), String(process.pid));
    return await task();
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}
