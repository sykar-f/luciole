/* Attach the inherited PTY before exec. No fork: Bun's pid stays the program's pid. */
#include <errno.h>
#include <stdio.h>
#include <sys/ioctl.h>
#include <unistd.h>

int main(int argc, char **argv) {
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
