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

function inspectGroup(pid: number): string | undefined {
  // Darwin's killpg1 excludes SZOMB, then returns EPERM if no member was
  // eligible. Inspect all groups: ps selection flags differ across platforms.
  // https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c
  try {
    const snapshot = Bun.spawnSync(["/bin/ps", "-axo", "pgid=,pid=,stat="], {
      env: { ...process.env, LC_ALL: "C" },
    });
    if (snapshot.exitCode !== 0)
      return `ps exited ${snapshot.exitCode}: ${snapshot.stderr.toString().slice(0, 512)}`;
    const lines = snapshot.stdout.toString().trim().split("\n");
    const members: string[] = [];
    let count = 0;
    for (const line of lines) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
      if (
        !match ||
        !Number.isSafeInteger(Number(match[1])) ||
        !Number.isSafeInteger(Number(match[2]))
      )
        return `unparsed ps row: ${JSON.stringify(line.slice(0, 128))}`;
      if (Number(match[1]) !== pid) continue;
      const state = match[3] ?? "";
      // Other groups can have undocumented/transient states, irrelevant here.
      // Every target member must be a zombie with only known state modifiers.
      if (!/^Z[<>ANLEsSlw+VXW]*$/.test(state)) {
        count++;
        if (members.length < 8) members.push(`pid ${match[2]} state ${state.slice(0, 64)}`);
      }
    }
    if (count > 0)
      return `live or unknown members: ${members.join(", ")}${count > members.length ? ` (${count - members.length} more)` : ""}`;
    return undefined;
  } catch (error) {
    return `ps inspection threw: ${String(error).slice(0, 512)}`;
  }
}
