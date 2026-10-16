/** Process isolation for explicitly selected pixel-host browser proofs. */
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLEANUP_MS = 1_000;
const EXECUTABLE_MODE = 0o700;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

// The journey selects its native scale through Browser.start; retain the DPR argument
// for callers that also pass it to the journey entry point.
export async function pixelJourney(entry: string, args: string[], timeout: number, _dpr = 1) {
  const scratch = mkdtempSync(join(tmpdir(), "pixel-chrome-"));
  const launcher = join(scratch, "chrome");
  writeFileSync(
    launcher,
    `#!/bin/sh\nexec ${quote(process.env.CHROME ?? CHROME)} --use-mock-keychain --password-store=basic --disable-extensions "$@"\n`,
  );
  chmodSync(launcher, EXECUTABLE_MODE);
  const child = spawn(process.execPath, [entry, ...args], {
    detached: true,
    stdio: "inherit",
    env: { ...process.env, CHROME: launcher },
  });
  const kill = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    kill("SIGKILL");
  }, timeout);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    if (timedOut) throw new Error(`${entry} exceeded ${timeout} ms`);
    if (code !== 0) throw new Error(`${entry} exited ${code}`);
  } finally {
    clearTimeout(timer);
    kill("SIGTERM");
    await Bun.sleep(CLEANUP_MS);
    kill("SIGKILL");
    // Leave the launcher in the test's TMPDIR for orch's cleanup.
  }
}
