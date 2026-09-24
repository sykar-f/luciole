/**
 * A program on a pseudo-terminal, with Bun's own PTY (`Bun.Terminal`): no native addon,
 * no helper binary. POSIX only; Bun has no PTY on Windows.
 *
 * `detached: true` is not optional. Without it the child shares the Client's session and
 * the PTY never becomes its controlling terminal: a shell warns "no job control", Ctrl+C
 * reaches no foreground process group and `sleep 30` survives it. Detached, Bun calls
 * setsid() and makes the PTY the controlling terminal of the new session, as a terminal
 * emulator or tmux does; closing the PTY then hangs the whole session up
 * (probes/vt-embed).
 */
import { existsSync, fstatSync, readdirSync, statSync } from "node:fs";
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
/**
 * The path of the terminal device a descriptor opened since `before` refers to: a PTY
 * slave `Bun.Terminal` just allocated. Bun does not say it; the device number does.
 */
function newSlave(before: ReadonlySet<number>) {
  // macOS names slaves /dev/ttysNNN, Linux /dev/pts/N.
  const candidates = [
    ...readdirSync("/dev")
      .filter((name) => /^ttys\d+$/.test(name))
      .map((name) => `/dev/${name}`),
    ...(existsSync("/dev/pts") ? readdirSync("/dev/pts").map((name) => `/dev/pts/${name}`) : []),
  ];
  const devices = new Map(candidates.map((path) => [statSync(path).rdev, path]));
  for (const fd of openDescriptors()) {
    if (before.has(fd)) continue;
    try {
      const stat = fstatSync(fd);
      const path = stat.isCharacterDevice() ? devices.get(stat.rdev) : undefined;
      if (path) return path;
    } catch {}
  }
  throw new Error("The new PTY's device path could not be found");
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
    onExit: (_child, code) => {
      terminal.close();
      options.onExit(code);
    },
  });
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
