/** Signal an owned process group; an exited group needs no further signal. */
export function signalGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error)) throw error;
    if (error.code === "ESRCH") return;
    if (error.code === "EPERM" && groupHasExited(pid)) return;
    throw error;
  }
}

function groupHasExited(pid: number): boolean {
  // Darwin's killpg1 excludes SZOMB, then returns EPERM if no member was
  // eligible. Inspect all groups: ps selection flags differ across platforms.
  // https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c
  try {
    const snapshot = Bun.spawnSync(["/bin/ps", "-axo", "pgid=,stat="], {
      env: { ...process.env, LC_ALL: "C" },
    });
    if (snapshot.exitCode !== 0) return false;
    const lines = snapshot.stdout.toString().trim().split("\n");
    for (const line of lines) {
      const match = /^\s*(\d+)\s+([RSDTtZXIWUKNP][<NLEsSlw+VX]*)\s*$/.exec(line);
      if (!match) return false;
      if (Number(match[1]) === pid && !match[2]?.startsWith("Z")) return false;
    }
    return true;
  } catch {
    return false;
  }
}
