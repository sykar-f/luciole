/* Attach the inherited PTY before exec. No fork: Bun's pid stays the program's pid. */
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

int main(int argc, char **argv) {
  /* No controlling terminal until the parent has installed its exit watcher.
   * Otherwise exit can wait for tty output while Bun's spawn waits for exit. */
  if (argc > 1 && strcmp(argv[1], "--wait-for-parent") == 0) {
    char ready = 0;
    ssize_t count;
    do {
      count = read(3, &ready, 1);
    } while (count == -1 && errno == EINTR);
    close(3);
    if (count != 1 || ready != 1) return 126;
    ++argv;
    --argc;
  }
  if (argc < 2) {
    fputs("luciole-pty: a command is required\n", stderr);
    return 126;
  }
  if ((getsid(0) != getpid() && setsid() == -1) || ioctl(0, TIOCSCTTY, 0) == -1) {
    perror("luciole-pty: attach controlling terminal");
    return 126;
  }
  execvp(argv[1], argv + 1);
  int status = errno == ENOENT ? 127 : 126;
  perror(argv[1]);
  return status;
}
