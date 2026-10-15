/** Owns the child before reporting it: no launch window can orphan a process. */
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod/mini";

const config = z
  .object({ command: z.array(z.string()), directory: z.optional(z.string()) })
  .parse(JSON.parse(process.argv[2] ?? ""));
function killGroup(pid: number) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
  }
}
function removeDirectory(directory: string) {
  // Only the fixture opts into this seam; no filesystem permissions depend on the host.
  if (process.env.LUCIOLE_TEST_GUARD_REMOVE_ERROR === "1")
    throw Object.assign(new Error("injected profile removal failure"), {
      code: "EIO",
      path: directory,
    });
  rmSync(directory, { recursive: true, force: true });
}
let child: Bun.Subprocess | undefined;
let exitCode = 1;
function describe(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  const code = "code" in error ? ` [${String(error.code)}]` : "";
  const path = "path" in error ? ` (${String(error.path)})` : "";
  return `${error.message}${code}${path}`;
}
try {
  child = Bun.spawn(config.command, {
    detached: true,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.send?.({ pid: child.pid });
  const ownerGone = (async () => {
    for await (const _chunk of Bun.stdin.stream()) {
      // EOF is the lifetime lease ending, including an owner's SIGKILL.
    }
  })();
  await Promise.race([ownerGone, child.exited]);
} finally {
  let cleanup: { ok: boolean; removed?: string; error?: string };
  try {
    if (child) {
      killGroup(child.pid);
      await child.exited;
    }
    if (config.directory) {
      removeDirectory(config.directory);
    }
    cleanup = { ok: true, removed: config.directory };
    exitCode = child?.exitCode ?? 1;
  } catch (error) {
    cleanup = { ok: false, error: describe(error) };
    console.error(`guard ${process.pid} cleanup failed: ${cleanup.error}`);
  }
  process.send?.({ cleanup });
  // The external test still observes the guard after its owner has been killed.
  const records = process.env.LUCIOLE_TEST_GUARD_RECORDS;
  if (records) {
    const path = join(records, `${process.pid}.json`);
    writeFileSync(`${path}.tmp`, JSON.stringify({ guard: process.pid, exitCode, cleanup }));
    renameSync(`${path}.tmp`, path);
  }
}
process.exit(exitCode);
