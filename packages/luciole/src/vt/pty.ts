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
/** Scans of /dev for a new slave, and the pause between two. */
// Up to 2 s: on a loaded machine where PTYs of other sessions come and go, the new
// slave took longer than the 100 ms first allowed to show up in /dev.
const SCAN_ATTEMPTS = 40;
const SCAN_PAUSE_MS = 50;
/**
 * The PTY slaves by device number. Other processes open and close PTYs meanwhile: one
 * listed but gone by the time it is examined is skipped.
 */
function slaves() {
  // macOS names slaves /dev/ttysNNN, Linux /dev/pts/N.
  const candidates = [
    ...readdirSync("/dev")
      .filter((name) => /^ttys\d+$/.test(name))
      .map((name) => `/dev/${name}`),
    ...(existsSync("/dev/pts") ? readdirSync("/dev/pts").map((name) => `/dev/pts/${name}`) : []),
  ];
  const devices = new Map<number, string>();
  for (const path of candidates) {
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat) devices.set(stat.rdev, path);
  }
  return devices;
}
/**
 * The path of the terminal device a descriptor opened since `before` refers to: a PTY
 * slave `Bun.Terminal` just allocated. Bun does not say it; the device number does.
 */
function newSlave(before: ReadonlySet<number>) {
  const opened = new Set<number>();
  for (const fd of openDescriptors()) {
    if (before.has(fd)) continue;
    try {
      const stat = fstatSync(fd);
      if (stat.isCharacterDevice()) opened.add(stat.rdev);
    } catch {}
  }
  // A slave just allocated may not be listed in /dev yet while PTYs come and go.
  for (let attempt = 0; attempt < SCAN_ATTEMPTS; attempt++) {
    const devices = slaves();
    for (const rdev of opened) {
      const path = devices.get(rdev);
      if (path) return path;
    }
    Bun.sleepSync(SCAN_PAUSE_MS);
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
