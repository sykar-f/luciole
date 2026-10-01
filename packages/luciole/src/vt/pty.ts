/**
 * A program on a pseudo-terminal, with Bun's own PTY (`Bun.Terminal`): no native addon,
 * no helper binary. POSIX only; Bun has no PTY on Windows.
 *
 * `detached: true` is not optional. Without it the child shares the Client's session and
 * the PTY never becomes its controlling terminal: a shell warns "no job control", Ctrl+C
 * reaches no foreground process group and `sleep 30` survives it. Detached, Bun calls
 * setsid() and makes the PTY the controlling terminal of the new session, as a terminal
 * emulator or tmux does; closing the PTY then hangs the whole session up
 */
import { fstatSync, readdirSync, realpathSync } from "node:fs";
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

/** The open file descriptors of this process. */
const openDescriptors = () => new Set(readdirSync("/dev/fd").map(Number));
/** What a PTY slave is called: macOS /dev/ttysNNN, Linux /dev/pts/N. */
const SLAVE_PATH = /^\/dev\/(?:ttys\d+|pts\/\d+)$/;
/**
 * The path of the terminal device a descriptor opened since `before` refers to: a PTY
 * slave `Bun.Terminal` just allocated. Bun does not say it, the descriptor does:
 * `realpath` of /dev/fd/<n> asks the kernel, not a listing of /dev, so nothing waits on
 * time. Verified on macOS only (F_GETPATH: 200 PTYs in a row, each path present and with
 * the descriptor's device number). On Linux this is reasoning, not a run: /dev/fd is
 * /proc/self/fd, whose entries are symlinks to /dev/pts/N. Why the old scan of /dev
 * missed the entry under load is a hypothesis (a listing racing other processes' PTYs
 * coming and going), not something measured. The master (/dev/ptmx) never matches.
 */
function newSlave(before: ReadonlySet<number>) {
  for (const fd of openDescriptors()) {
    if (before.has(fd)) continue;
    try {
      if (!fstatSync(fd).isCharacterDevice()) continue;
      const path = realpathSync(`/dev/fd/${fd}`);
      if (SLAVE_PATH.test(path)) return path;
    } catch {}
  }
  throw new Error("The new PTY's device path could not be found");
}
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
  const before = typeof options.command === "function" ? openDescriptors() : undefined;
  const terminal = new Bun.Terminal({
    cols: options.cols,
    rows: options.rows,
    name: "xterm-256color",
    data: (_terminal, bytes) => options.onData(bytes),
  });
  let command: readonly string[];
  try {
    command =
      typeof options.command === "function"
        ? options.command(newSlave(before ?? new Set()))
        : options.command;
    if (!command[0]) throw new Error("A terminal needs a command");
  } catch (error: unknown) {
    terminal.close();
    throw error;
  }
  const own = options.environment === "replace" ? {} : process.env;
  const child = Bun.spawn([...command], {
    terminal,
    detached: true,
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
