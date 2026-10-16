/** Signal an owned process group; an exited group needs no further signal. */
export function signalGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error)) throw error;
    if (error.code === "ESRCH") return;
    if (error.code === "EPERM") {
      const failure = inspectGroup(pid);
      if (failure === undefined) return;
      throw Object.assign(
        new Error(`${error.message}; process group ${pid} inspection failed: ${failure}`, {
          cause: error,
        }),
        { code: error.code },
      );
    }
    throw error;
  }
}

// Only exiting members get a settling window. This is 1/20 of the owner's
// existing 5s shutdown bound; every ps invocation shares the same 250ms budget.
const exitSettlementMs = 250;

function inspectGroup(pid: number): string | undefined {
  const deadline = performance.now() + exitSettlementMs;
  let inspection = readGroup(pid, exitSettlementMs);
  while (inspection?.exiting) {
    let remaining = deadline - performance.now();
    if (remaining <= 0) break;
    Bun.sleepSync(Math.min(10, remaining));
    remaining = deadline - performance.now();
    if (remaining <= 0) break;
    inspection = readGroup(pid, remaining);
  }
  if (inspection?.exiting)
    return `exit did not complete within ${exitSettlementMs}ms: ${inspection.reason}`;
  return inspection?.reason;
}

function readGroup(pid: number, timeout: number): { reason: string; exiting: boolean } | undefined {
  const failed = (reason: string) => ({ reason, exiting: false });
  // Darwin's killpg1 excludes SZOMB, then returns EPERM if no member was
  // eligible. pgrp_iterate also skips exiting members that proc_find cannot
  // reference (P_REF_DEAD). Inspect all groups: ps flags differ by platform.
  // https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c
  try {
    const snapshot = Bun.spawnSync(["/bin/ps", "-axo", "pgid=,pid=,stat="], {
      env: { ...process.env, LC_ALL: "C" },
      timeout,
    });
    if (snapshot.exitCode !== 0)
      return failed(`ps exited ${snapshot.exitCode}: ${snapshot.stderr.toString().slice(0, 512)}`);
    const lines = snapshot.stdout.toString().trim().split("\n");
    const members: string[] = [];
    let count = 0;
    let live = false;
    for (const line of lines) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
      if (
        !match ||
        !Number.isSafeInteger(Number(match[1])) ||
        !Number.isSafeInteger(Number(match[2]))
      )
        return failed(`unparsed ps row: ${JSON.stringify(line.slice(0, 128))}`);
      if (Number(match[1]) !== pid) continue;
      const state = match[3] ?? "";
      // Other groups can have undocumented/transient states, irrelevant here.
      // Darwin ps appends E for P_WEXIT on non-zombies, even when no Mach
      // thread state remains (?). E is only provisional: require a later
      // snapshot with no non-zombie members before declaring success.
      // https://github.com/apple-oss-distributions/adv_cmds/blob/main/ps/print.c
      if (!/^Z[<>ANLEsSlw+VXW]*$/.test(state)) {
        count++;
        if (!/^[RUSITH?][<N]?X?EV?L?s?\+?$/.test(state)) live = true;
        if (members.length < 8) members.push(`pid ${match[2]} state ${state.slice(0, 64)}`);
      }
    }
    if (count > 0)
      return {
        reason: `${live ? "live or unknown" : "exiting"} members: ${members.join(", ")}${count > members.length ? ` (${count - members.length} more)` : ""}`,
        exiting: !live,
      };
    return undefined;
  } catch (error) {
    return failed(`ps inspection threw: ${String(error).slice(0, 512)}`);
  }
}
