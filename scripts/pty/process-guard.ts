/** Owns the child before reporting it: no launch window can orphan a process. */
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod/mini";
import { signalGroup } from "./process-group";

const config = z
  .object({ command: z.array(z.string()), directory: z.optional(z.string()) })
  .parse(JSON.parse(process.argv[2] ?? ""));
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
  const failures: string[] = [];
  if (child) {
    try {
      if (process.env.LUCIOLE_TEST_GUARD_KILL_ERROR === "1")
        throw Object.assign(new Error("injected group kill failure"), { code: "EPERM" });
      signalGroup(child.pid, "SIGKILL");
      await child.exited;
    } catch (error) {
      failures.push(`process group ${child.pid}: ${describe(error)}`);
    }
  }
  let removed: string | undefined;
  if (config.directory) {
    try {
      removeDirectory(config.directory);
      removed = config.directory;
    } catch (error) {
      failures.push(`profile removal: ${describe(error)}`);
    }
  }
  if (failures.length === 0) {
    cleanup = { ok: true, removed };
    exitCode = child?.exitCode ?? 1;
  } else {
    cleanup = { ok: false, removed, error: failures.join("; ") };
    console.error(`guard ${process.pid} cleanup failed: ${cleanup.error}`);
  }
  // Exercise a genuinely missing report without leaving child resources alive.
  if (process.env.LUCIOLE_TEST_GUARD_DISCONNECT === "1") process.disconnect?.();
  if (process.connected) {
    // A send callback confirms dispatch, not that the owner read the report.
    // Keep the guard alive until receipt; owner death must still release it.
    await new Promise<void>((resolve) => {
      const done = () => {
        process.off("message", received);
        process.off("disconnect", done);
        resolve();
      };
      const received = (message: unknown) => {
        if (z.object({ cleanupReceived: z.literal(true) }).safeParse(message).success) done();
      };
      process.on("message", received);
      process.once("disconnect", done);
      // Defer transport dispatch to reproduce an exit overtaking report delivery.
      const send = () => {
        if (process.connected) process.send?.({ cleanup });
        else done();
      };
      if (process.env.LUCIOLE_TEST_GUARD_DEFER_REPORT === "1") setImmediate(send);
      else send();
    });
  }
  // The external test still observes the guard after its owner has been killed.
  const records = process.env.LUCIOLE_TEST_GUARD_RECORDS;
  if (records) {
    const path = join(records, `${process.pid}.json`);
    writeFileSync(`${path}.tmp`, JSON.stringify({ guard: process.pid, exitCode, cleanup }));
    renameSync(`${path}.tmp`, path);
  }
}
process.exit(exitCode);
