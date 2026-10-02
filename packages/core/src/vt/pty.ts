/**
 * A program on a pseudo-terminal, with Bun's own PTY (`Bun.Terminal`): no native addon.
 * POSIX only; Bun has no PTY on Windows.
 *
 * The program must lead a session of its own whose controlling terminal is the PTY.
 * Otherwise a shell warns "job control turned off", Ctrl+C reaches no foreground process
 * group and `sleep 30` survives it. A terminal emulator or tmux does the same; closing
 * the PTY then hangs the whole session up.
 * - macOS: `detached: true` is enough. Bun calls setsid() and the PTY becomes the
 *   controlling terminal of the new session.
 * - Linux: Bun 1.4.2 calls setsid() too but never TIOCSCTTY, so the session has no
 *   terminal (`ps` shows TPGID -1). `setsid -c` (util-linux, busybox) does both and
 *   then execs the program, which keeps the pid Bun returns. It is spawned in the
 *   Client's group, not detached, because setsid() fails for a group leader: `setsid`
 *   would then fork, and the pid would no longer be the program's. Without `setsid`
 *   the program still runs, without job control.
 */
import { fstatSync, readdirSync, readSync, realpathSync } from "node:fs";
export type PtyOptions = {
  /**
   * The program and its arguments; a function receives the exact path of the PTY's
   * slave first (a sandbox profile grants that device and no other).
   */
  command: readonly string[] | ((tty: string) => readonly string[]);
  cols: number;
  rows: number;
  env?: Record<string, string | undefined>;
  /** `replace`: `env` is the program's whole environment, nothing of the Client's. */
  environment?: "inherit" | "replace";
  cwd?: string;
  /** Opens Bun's IPC channel to the program (JSON), and receives its messages. */
  ipc?: (message: unknown) => void;
  /** What the program wrote, to feed an emulator. */
  onData: (bytes: Uint8Array) => void;
  onExit: (code: number | null) => void;
};
export type Pty = {
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  /** Sends a message over the IPC channel, when `ipc` opened one. */
  send(message: unknown): void;
  readonly pid: number;
};

/**
 * The open file descriptors of this process, each with what it refers to. A number alone
 * does not say a descriptor is old: listing /dev/fd opens a directory descriptor that is
 * closed again, and any descriptor closed meanwhile (a pool thread, an earlier test's
 * cleanup) frees a number the PTY then takes. What a number refers to does not repeat.
 */
function openDescriptors() {
  const open = new Map<number, string>();
  for (const fd of readdirSync("/dev/fd").map(Number)) {
    try {
      const { dev, ino, rdev } = fstatSync(fd);
      open.set(fd, `${dev}:${ino}:${rdev}`);
    } catch {}
  }
  return open;
}
/** What a PTY slave is called: macOS /dev/ttysNNN, Linux /dev/pts/N. */
const SLAVE_PATH = /^\/dev\/(?:ttys\d+|pts\/\d+)$/;
/**
 * The path of the terminal device a descriptor opened since `before` refers to: a PTY
 * slave `Bun.Terminal` just allocated. Bun does not say it, the descriptor does:
 * `realpath` of /dev/fd/<n> asks the kernel, not a listing of /dev, so nothing waits on
 * time. Verified on macOS only (F_GETPATH: 200 PTYs in a row, each path present and with
 * the descriptor's device number). On Linux this is reasoning, not a run: /dev/fd is
 * /proc/self/fd, whose entries are symlinks to /dev/pts/N. The master (/dev/ptmx) never
 * matches.
 */
function newSlave(before: ReadonlyMap<number, string>) {
  for (const [fd, identity] of openDescriptors()) {
    if (before.get(fd) === identity) continue;
    try {
      if (!fstatSync(fd).isCharacterDevice()) continue;
      const path = realpathSync(`/dev/fd/${fd}`);
      if (SLAVE_PATH.test(path)) return path;
    } catch {}
  }
  throw new Error("The new PTY's device path could not be found");
}
/** The master side of every PTY on Linux: /dev/ptmx (or devpts' own), major 5, minor 2. */
const PTMX = 0x502;
const DRAIN_BYTES = 65536;
/**
 * How far the exit reads: what a program leaves in the PTY is at most what the kernel
 * buffers before its writer blocks (11.5 KiB measured on Linux 6.12), while a job it left
 * behind may write on forever and the Client, reading synchronously, would do nothing
 * else. A count, not a clock, so that a loaded machine reads the same.
 */
const DRAIN_LIMIT_BYTES = 262144;
/**
 * On Linux `Bun.Terminal` keeps the slave open, so its stream never ends, and the
 * program's exit often comes before its last bytes are read (1 run in 7 for a
 * `printf` that exits at once): closing the PTY then loses them. Its writes are in the
 * kernel by then; poll() may not say so yet (they reach the master through a deferred
 * flush), but a read flushes them first. So the exit reads the master to the end,
 * synchronously, before closing it: in order, all of it (800 runs of 800 measured), up
 * to a bound that a job still writing reaches instead.
 * On macOS the stream ends first, with the program's last bytes.
 */
function masterOf(before: ReadonlyMap<number, string>) {
  for (const [fd, identity] of openDescriptors()) {
    if (before.get(fd) === identity) continue;
    try {
      if (fstatSync(fd).rdev === PTMX) return fd;
    } catch {}
  }
  return undefined;
}
function drain(master: number, onData: (bytes: Uint8Array) => void) {
  const buffer = new Uint8Array(DRAIN_BYTES);
  for (let total = 0; total < DRAIN_LIMIT_BYTES;) {
    let read = 0;
    try {
      read = readSync(master, buffer);
    } catch {
      // EAGAIN: nothing left; EIO: the slave is gone with what it wrote.
      return;
    }
    if (read === 0) return;
    total += read;
    onData(buffer.slice(0, read));
  }
}
/** Linux's way to give the program its terminal (see the header); the host's PATH. */
const SETSID = process.platform === "linux" ? Bun.which("setsid") : null;
/**
 * The programs still running, by pid, with the PTY each one holds. A host that quits
 * through `process.exit` (a signal, a quit) unmounts nothing, so nothing else ends them.
 */
const live = new Map<number, Bun.Terminal>();
let exitHooked = false;
/**
 * At exit: SIGKILL to the program's process group (it leads the group, `setsid`, so its
 * pid is the group's; there is no time to wait for it to save, and one ignoring SIGHUP
 * dies too), then the PTY's master closes, which hangs up the session leader and the
 * foreground group. A job that left the group and ignores SIGHUP (nohup, disown)
 * survives: nothing here signals every member of the session.
 */
function killAll() {
  for (const [pid, terminal] of live) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
    terminal.close();
  }
  live.clear();
}
export function spawnPty(options: PtyOptions): Pty {
  const linux = process.platform === "linux";
  const before = typeof options.command === "function" || linux ? openDescriptors() : undefined;
  const terminal = new Bun.Terminal({
    cols: options.cols,
    rows: options.rows,
    name: "xterm-256color",
    data: (_terminal, bytes) => options.onData(bytes),
  });
  const master = linux && before ? masterOf(before) : undefined;
  let command: readonly string[];
  try {
    command =
      typeof options.command === "function"
        ? options.command(newSlave(before ?? new Map()))
        : options.command;
    if (!command[0]) throw new Error("A terminal needs a command");
  } catch (error: unknown) {
    terminal.close();
    throw error;
  }
  const own = options.environment === "replace" ? {} : process.env;
  const child = Bun.spawn(SETSID ? [SETSID, "-c", ...command] : [...command], {
    terminal,
    detached: !SETSID,
    cwd: options.cwd,
    // TERM names what the emulator answers to (terminfo, DA); COLORTERM advertises the
    // truecolor it renders.
    env: { ...own, TERM: "xterm-256color", COLORTERM: "truecolor", ...options.env },
    ...(options.ipc && {
      ipc: (message: unknown) => options.ipc?.(message),
      serialization: "json",
    }),
    onExit: (child, code) => {
      live.delete(child.pid);
      if (master !== undefined && !terminal.closed) drain(master, options.onData);
      terminal.close();
      options.onExit(code);
    },
  });
  live.set(child.pid, terminal);
  if (!exitHooked) {
    exitHooked = true;
    process.on("exit", killAll);
  }
  return {
    write: (data) => {
      if (!terminal.closed) terminal.write(data);
    },
    // TIOCSWINSZ: the kernel sends SIGWINCH to the foreground process group.
    resize: (cols, rows) => {
      if (!terminal.closed) terminal.resize(cols, rows);
    },
    // A hangup, as when a terminal window closes: shells and editors save and leave.
    kill: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGHUP");
    },
    send: (message) => {
      if (options.ipc && child.exitCode === null && child.signalCode === null) child.send(message);
    },
    pid: child.pid,
  };
}
