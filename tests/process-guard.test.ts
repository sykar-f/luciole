import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eventually, temporaryDirectory } from "../scripts/pty/harness";
import { managedProcess } from "../scripts/pty/process";
import { signalGroup } from "../scripts/pty/process-group";

// A separate parent retains an unreaped child in the managed leader's group.
// It stays in the same session but moves itself to another group before forking.
// Thus the guard can reap its leader while the original group contains a zombie.
const fixture = temporaryDirectory("guard-zombie-", process.env.TMPDIR);
const executable = join(fixture.path, "zombie");
beforeAll(async () => {
  const source = join(fixture.path, "zombie.c");
  writeFileSync(
    source,
    `
#include <sys/types.h>
#include <sys/wait.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc != 4) return 2;
  int ready[2];
  if (pipe(ready)) return 3;
  pid_t group = getpgrp();
  pid_t keeper = fork();
  if (keeper < 0) return 4;
  if (keeper == 0) {
    close(ready[0]);
    close(0); close(1); close(2);
    if (setpgid(0, 0)) _exit(5);
    pid_t zombie = fork();
    if (zombie < 0) _exit(6);
    if (zombie == 0) {
      if (setpgid(0, group)) _exit(7);
      _exit(0);
    }
    siginfo_t info;
    if (waitid(P_PID, zombie, &info, WEXITED | WNOWAIT)) _exit(8);
    FILE *record = fopen(argv[1], "w");
    fprintf(record, "%d %d\\n", getpid(), zombie);
    fclose(record);
    if (write(ready[1], "x", 1) != 1) _exit(9);
    close(ready[1]);
    while (access(argv[3], F_OK)) usleep(1000);
    waitpid(zombie, NULL, 0);
    _exit(0);
  }
  close(ready[1]);
  char byte;
  if (read(ready[0], &byte, 1) != 1) return 10;
  close(ready[0]);
  while (access(argv[2], F_OK)) usleep(1000);
  return 0;
}
`,
  );
  if (!Bun.which("cc")) throw new Error("process guard fixture requires a C compiler (cc)");
  const compiler = Bun.spawn(["cc", "-Wall", "-Werror", source, "-o", executable], {
    stderr: "pipe",
  });
  expect(await compiler.exited, await new Response(compiler.stderr).text()).toBe(0);
});

afterAll(() => fixture[Symbol.dispose]());

for (const exit of ["natural", "SIGTERM"] as const) {
  test(`guard cleans a zombie-only group after ${exit} exit`, async () => {
    using directory = temporaryDirectory("guard-case-", process.env.TMPDIR);
    const record = join(directory.path, "ready");
    const finish = join(directory.path, "finish");
    const release = join(directory.path, "release");
    const profile = join(directory.path, "profile");
    mkdirSync(profile);
    const managed = await managedProcess([executable, record, finish, release], {
      directory: profile,
    });
    const stderr = new Response(managed.child.stderr).text();
    let keeper: number | undefined;
    try {
      expect(await eventually(() => existsSync(record))).toBe(true);
      keeper = Number(readFileSync(record, "utf8").split(" ")[0]);
      if (exit === "natural") {
        writeFileSync(finish, "");
        await managed.child.exited;
        const snapshot = Bun.spawnSync(["ps", "-axo", "pgid=,stat="]);
        const members = snapshot.stdout
          .toString()
          .trim()
          .split("\n")
          .map((line) => line.trim().split(/\s+/))
          .filter(([group]) => Number(group) === managed.child.pid);
        expect(members.length).toBeGreaterThan(0);
        expect(members.every(([, state]) => state?.startsWith("Z"))).toBe(true);
        if (process.platform === "darwin") {
          expect(() => process.kill(-managed.child.pid, 0)).toThrow("EPERM");
        }
      }
      await managed.stop();
      expect(existsSync(profile)).toBe(false);
      expect(await stderr).toBe("");
    } finally {
      writeFileSync(finish, "");
      writeFileSync(release, "");
      if (keeper) {
        const keeperPid = keeper;
        await eventually(() => {
          try {
            process.kill(keeperPid, 0);
            return false;
          } catch {
            return true;
          }
        });
      }
      await managed.child.exited;
    }
  });
}

for (const removalError of [false, true]) {
  test(`group kill failure still attempts profile removal (failure: ${removalError})`, async () => {
    using directory = temporaryDirectory("guard-failures-", process.env.TMPDIR);
    const profile = join(directory.path, "profile");
    mkdirSync(profile);
    const managed = await managedProcess([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      directory: profile,
      env: {
        ...process.env,
        LUCIOLE_TEST_GUARD_KILL_ERROR: "1",
        LUCIOLE_TEST_GUARD_REMOVE_ERROR: removalError ? "1" : "0",
      },
    });
    const stderr = new Response(managed.child.stderr).text();
    expect(managed.stop()).rejects.toThrow("injected group kill failure");
    expect(existsSync(profile)).toBe(removalError);
    const errors = await stderr;
    expect(errors).toContain("process group");
    expect(errors).toContain("EPERM");
    if (removalError) {
      expect(errors).toContain("profile removal");
      expect(errors).toContain("injected profile removal failure");
      expect(errors).toContain("EIO");
      expect(errors).toContain(profile);
    }
  });
}

test("a live group with EPERM remains a failure", async () => {
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdout: "ignore",
    stderr: "ignore",
  });
  const denial = Object.assign(new Error("live group denied"), { code: "EPERM" });
  const kill = spyOn(process, "kill").mockImplementation(() => {
    throw denial;
  });
  try {
    expect(() => signalGroup(child.pid, "SIGKILL")).toThrow(denial.message);
  } finally {
    kill.mockRestore();
    process.kill(-child.pid, "SIGKILL");
    await child.exited;
  }
});

for (const output of [
  "",
  "not a process table",
  "123 321 S\nbroken",
  "123 321 Zgarbage",
  "123 321 ?",
  "123 321 ?Egarbage",
]) {
  test(`EPERM inspection fails closed for invalid ps output ${JSON.stringify(output)}`, () => {
    const denial = Object.assign(new Error("denied"), { code: "EPERM" });
    const kill = spyOn(process, "kill").mockImplementation(() => {
      throw denial;
    });
    const snapshot = spyOn(Bun, "spawnSync").mockReturnValue({
      ...Bun.spawnSync(["/bin/ps", "-axo", "pgid=,pid=,stat="]),
      exitCode: 0,
      stdout: Buffer.from(output),
      stderr: Buffer.alloc(0),
    });
    try {
      expect(() => signalGroup(123, "SIGKILL")).toThrow(denial.message);
    } finally {
      kill.mockRestore();
      snapshot.mockRestore();
    }
  });
}

test("EPERM inspection fails closed when ps fails", () => {
  const denial = Object.assign(new Error("denied"), { code: "EPERM" });
  const kill = spyOn(process, "kill").mockImplementation(() => {
    throw denial;
  });
  const snapshot = spyOn(Bun, "spawnSync").mockImplementation(() => {
    throw new Error("ps failed");
  });
  try {
    expect(() => signalGroup(123, "SIGKILL")).toThrow("ps inspection threw: Error: ps failed");
  } finally {
    kill.mockRestore();
    snapshot.mockRestore();
  }
});

// Union of modifiers documented by macOS ps(1) and Linux procps ps(1).
const stateModifiers = "<>AELNSsVWXl+";
for (const output of [
  "456 654 S",
  "123 321 Z",
  "123 321 Z+\n456 654 S",
  "123 321 Z\n456 654 S>",
  "123 321 Z\n456 654 H",
  "123 321 Z\n456 654 ?",
  "123 321 Z\n456 654 ?E",
  ...Array.from(stateModifiers, (modifier) => `123 321 Z${modifier}\n456 654 S${modifier}`),
]) {
  test(`EPERM accepts a verified exited group: ${JSON.stringify(output)}`, () => {
    const denial = Object.assign(new Error("denied"), { code: "EPERM" });
    const kill = spyOn(process, "kill").mockImplementation(() => {
      throw denial;
    });
    const snapshot = spyOn(Bun, "spawnSync").mockReturnValue({
      ...Bun.spawnSync(["/bin/ps", "-axo", "pgid=,pid=,stat="]),
      exitCode: 0,
      stdout: Buffer.from(output),
      stderr: Buffer.alloc(0),
    });
    try {
      expect(() => signalGroup(123, "SIGTERM")).not.toThrow();
    } finally {
      kill.mockRestore();
      snapshot.mockRestore();
    }
  });
}

test("EPERM rejects an unsuccessful ps result even with zombie output", () => {
  const denial = Object.assign(new Error("denied"), { code: "EPERM" });
  const kill = spyOn(process, "kill").mockImplementation(() => {
    throw denial;
  });
  const snapshot = spyOn(Bun, "spawnSync").mockReturnValue({
    ...Bun.spawnSync(["/bin/ps", "-axo", "pgid=,pid=,stat="]),
    exitCode: 1,
    stdout: Buffer.from("123 321 Z"),
    stderr: Buffer.from("ps failed"),
  });
  try {
    expect(() => signalGroup(123, "SIGKILL")).toThrow("ps exited 1: ps failed");
  } finally {
    kill.mockRestore();
    snapshot.mockRestore();
  }
});

for (const { output, reason } of [
  { output: "unreadable", reason: 'unparsed ps row: "unreadable"' },
  { output: "invalid 321 Z", reason: 'unparsed ps row: "invalid 321 Z"' },
  { output: "123 321 S>", reason: "live or unknown members: pid 321 state S>" },
  {
    output: "123 321 ?E",
    reason: "exit did not complete within 250ms: exiting members: pid 321 state ?E",
  },
  {
    output: "123 321 Z\n123 322 S\n123 323 R",
    reason: "live or unknown members: pid 322 state S, pid 323 state R",
  },
]) {
  test(`inspection failure explains ${JSON.stringify(output)}`, () => {
    const denial = Object.assign(new Error("denied"), { code: "EPERM" });
    const kill = spyOn(process, "kill").mockImplementation(() => {
      throw denial;
    });
    const snapshot = spyOn(Bun, "spawnSync").mockReturnValue({
      ...Bun.spawnSync(["/bin/ps", "-axo", "pgid=,pid=,stat="]),
      exitCode: 0,
      stdout: Buffer.from(output),
      stderr: Buffer.alloc(0),
    });
    try {
      expect(() => signalGroup(123, "SIGKILL")).toThrow(reason);
    } finally {
      kill.mockRestore();
      snapshot.mockRestore();
    }
  });
}

test("inspection diagnostics bound the number of target members", () => {
  const denial = Object.assign(new Error("denied"), { code: "EPERM" });
  const kill = spyOn(process, "kill").mockImplementation(() => {
    throw denial;
  });
  const snapshot = spyOn(Bun, "spawnSync").mockReturnValue({
    ...Bun.spawnSync(["/bin/ps", "-axo", "pgid=,pid=,stat="]),
    exitCode: 0,
    stdout: Buffer.from(
      Array.from({ length: 10 }, (_, index) => `123 ${321 + index} S`).join("\n"),
    ),
    stderr: Buffer.alloc(0),
  });
  try {
    expect(() => signalGroup(123, "SIGKILL")).toThrow("pid 328 state S (2 more)");
  } finally {
    kill.mockRestore();
    snapshot.mockRestore();
  }
});

// Replay the observed Darwin exit race without relying on scheduler timing.
for (const [state, terminal] of [
  ["?E", "123 321 Z"],
  ["?E", "456 654 S"],
  ...Array.from("RUSITH?", (state) => [state + "<XEVLs+", "123 321 Z"]),
]) {
  test(`EPERM confirms an exiting member reaches a terminal snapshot: ${state} -> ${terminal}`, () => {
    const result = Bun.spawnSync(["/bin/ps", "-axo", "pgid=,pid=,stat="]);
    const denial = Object.assign(new Error("exiting group denied"), { code: "EPERM" });
    const kill = spyOn(process, "kill").mockImplementation(() => {
      throw denial;
    });
    const outputs = [`123 321 ${state}`, terminal];
    const snapshot = spyOn(Bun, "spawnSync").mockImplementation(() => ({
      ...result,
      exitCode: 0,
      stdout: Buffer.from(outputs.shift() ?? terminal),
      stderr: Buffer.alloc(0),
    }));
    try {
      expect(() => signalGroup(123, "SIGTERM")).not.toThrow();
      expect(snapshot).toHaveBeenCalledTimes(2);
      expect(kill).toHaveBeenCalledTimes(1);
    } finally {
      kill.mockRestore();
      snapshot.mockRestore();
    }
  });
}

for (const { next, reason, calls } of [
  {
    next: "123 321 ?E",
    reason: "exit did not complete within 250ms: exiting members: pid 321 state ?E",
    calls: 25,
  },
  { next: "123 321 S", reason: "live or unknown members: pid 321 state S", calls: 2 },
  { next: "123 321 ?", reason: "live or unknown members: pid 321 state ?", calls: 2 },
  {
    next: "123 321 ?E\n123 322 R",
    reason: "live or unknown members: pid 321 state ?E, pid 322 state R",
    calls: 2,
  },
  {
    next: "123 321 ?Egarbage",
    reason: "live or unknown members: pid 321 state ?Egarbage",
    calls: 2,
  },
  { next: "broken", reason: 'unparsed ps row: "broken"', calls: 2 },
]) {
  test(`exit settlement fails closed: ${JSON.stringify(next)}`, () => {
    const result = Bun.spawnSync(["/bin/ps", "-axo", "pgid=,pid=,stat="]);
    const denial = Object.assign(new Error("exiting group denied"), { code: "EPERM" });
    let elapsed = 0;
    let reads = 0;
    const now = spyOn(performance, "now").mockImplementation(() => elapsed);
    const sleep = spyOn(Bun, "sleepSync").mockImplementation((duration) => {
      elapsed += Number(duration);
    });
    const kill = spyOn(process, "kill").mockImplementation(() => {
      throw denial;
    });
    const snapshot = spyOn(Bun, "spawnSync").mockImplementation(() => ({
      ...result,
      exitCode: 0,
      stdout: Buffer.from(reads++ === 0 ? "123 321 ?E" : next),
      stderr: Buffer.alloc(0),
    }));
    try {
      expect(() => signalGroup(123, "SIGKILL")).toThrow(reason);
      expect(snapshot).toHaveBeenCalledTimes(calls);
      expect(kill).toHaveBeenCalledTimes(1);
      expect(elapsed).toBeLessThanOrEqual(250);
      expect(snapshot.mock.calls[0]?.[1]?.timeout).toBe(250);
      expect(snapshot.mock.calls[1]?.[1]?.timeout).toBe(240);
    } finally {
      snapshot.mockRestore();
      kill.mockRestore();
      sleep.mockRestore();
      now.mockRestore();
    }
  });
}
