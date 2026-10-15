import { beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eventually, temporaryDirectory } from "../scripts/pty/harness";
import { managedProcess } from "../scripts/pty/process";

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
  const compiler = Bun.spawn(["cc", "-Wall", "-Werror", source, "-o", executable], {
    stderr: "pipe",
  });
  expect(await compiler.exited, await new Response(compiler.stderr).text()).toBe(0);
});

for (const exit of ["natural", "SIGTERM"] as const) {
  test(`guard cleans a zombie-only group after ${exit} exit`, async () => {
    using directory = temporaryDirectory("guard-case-", process.env.TMPDIR);
    const record = join(directory.path, "ready");
    const finish = join(directory.path, "finish");
    const release = join(directory.path, "release");
    const profile = join(directory.path, "profile");
    const { mkdirSync } = await import("node:fs");
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
        await eventually(() => {
          try {
            process.kill(keeper, 0);
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
