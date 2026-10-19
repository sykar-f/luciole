/** Force the child to reach exit before Bun installs its process watcher. */
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execute, until } from "./helpers";

// Interpose only the launcher's spawn. Wait for a kernel state, not an elapsed
// delay: EVFILT_PROC returns ESRCH once the exiting session leader is draining
// its controlling terminal, before wait4 can reap it. A launcher waiting on a
// startup pipe is the other stable state; its read announces that state first.
const scheduler = String.raw`
#include <sys/event.h>
#include <sys/stat.h>
#include <spawn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static ssize_t scheduled_read(int fd, void *buffer, size_t length) {
  const char *barrier = getenv("PTY_SPAWN_BARRIER");
  if (fd >= 3 && barrier && strcmp(getprogname(), "luciole-pty") == 0) {
    int marker = open(barrier, O_WRONLY | O_CREAT | O_APPEND, 0600);
    if (marker == -1 || write(marker, "R", 1) != 1) _exit(120);
    close(marker);
  }
  return read(fd, buffer, length);
}

static int scheduled_spawn(pid_t *pid, const char *path,
    const posix_spawn_file_actions_t *actions, const posix_spawnattr_t *attr,
    char *const argv[], char *const env[]) {
  int result = posix_spawn(pid, path, actions, attr, argv, env);
  if (result || !strstr(path, "/luciole-pty")) return result;
  const char *barrier = getenv("PTY_SPAWN_BARRIER");
  int queue = kqueue();
  if (!barrier || queue == -1) _exit(121);
  for (;;) {
    struct stat status;
    if (stat(barrier, &status) == 0 && status.st_size > 0) {
      write(2, "scheduled: startup read\n", 24);
      break;
    }
    struct kevent change, receipt;
    EV_SET(&change, *pid, EVFILT_PROC, EV_ADD | EV_ONESHOT | EV_RECEIPT,
        NOTE_EXIT, 0, NULL);
    if (kevent(queue, &change, 1, &receipt, 1, NULL) != 1 ||
        !(receipt.flags & EV_ERROR)) _exit(122);
    if (receipt.data == ESRCH) {
      write(2, "scheduled: terminal exit\n", 25);
      break;
    }
    if (receipt.data != 0) _exit(123);
    EV_SET(&change, *pid, EVFILT_PROC, EV_DELETE | EV_RECEIPT, 0, 0, NULL);
    kevent(queue, &change, 1, &receipt, 1, NULL);
    usleep(1000);
  }
  close(queue);
  return result;
}

#define INTERPOSE(replacement, original) \
  __attribute__((used)) static struct { const void *a; const void *b; } \
  interpose_##original __attribute__((section("__DATA,__interpose"))) = \
    { (const void *)replacement, (const void *)original };
INTERPOSE(scheduled_spawn, posix_spawn)
INTERPOSE(scheduled_read, read)
`;

const scenarios = [
  {
    name: "a session leader cannot exit before its PTY process watcher is installed",
    program: `
import {spawnPty} from ${JSON.stringify(resolve("packages/core/src/vt/pty.ts"))};
let output = "";
spawnPty({command:["/bin/sh", "-c", "printf '[last-byte]'"], cols:80, rows:24,
 onData(bytes){output += new TextDecoder().decode(bytes)},
 onExit(code){console.log(JSON.stringify({code, output}))}});
console.error("spawn returned");
`,
    output: "[last-byte]",
  },
  {
    name: "the desktop environment probe cannot block in spawn's synchronous reap",
    program: `
import {createWindowSession} from ${JSON.stringify(resolve("packages/desktop/src/host/session.ts"))};
let output = "";
const session = createWindowSession({
 command:["/bin/sh", "-c", 'echo "[\${BUN_BE_BUN-unset}]"'], env:{BUN_BE_BUN:"1"},
 send(data){output += data},
 onExit(code){console.log(JSON.stringify({code, output}))}});
session.open({cols:40, rows:10});
console.error("spawn returned");
`,
    output: "[unset]\r\n",
  },
];

for (const scenario of scenarios)
  test.skipIf(process.platform !== "darwin")(scenario.name, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pty-spawn-order-"));
    try {
      const source = join(directory, "schedule.c");
      const library = join(directory, "schedule.dylib");
      await writeFile(source, scheduler);
      const build = await execute([
        "/usr/bin/clang",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-dynamiclib",
        source,
        "-o",
        library,
      ]);
      expect(build.stderr.toString()).toBe("");
      expect(build.exitCode).toBe(0);
      const entry = join(directory, "entry.ts");
      await writeFile(entry, scenario.program);
      const child = Bun.spawn([process.execPath, entry], {
        env: {
          ...process.env,
          DYLD_INSERT_LIBRARIES: library,
          PTY_SPAWN_BARRIER: join(directory, "startup-read"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = new Response(child.stdout).text();
      const stderr = new Response(child.stderr).text();
      try {
        // The test worker stays responsive even when Bun.spawn in the subject
        // blocks in wait4. The existing test wait bounds the observation.
        await until(() => child.exitCode !== null);
        expect(await child.exited).toBe(0);
        expect(JSON.parse((await stdout).trim())).toEqual({ code: 0, output: scenario.output });
        expect(await stderr).toContain("scheduled: startup read");
        expect(await stderr).toContain("spawn returned");
      } finally {
        if (child.exitCode === null) {
          try {
            process.kill(child.pid, "SIGKILL");
          } catch {}
        }
        await child.exited;
        await Promise.all([stdout, stderr]);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
