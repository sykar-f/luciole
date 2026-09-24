// A child process on a pseudo-terminal, with Bun's own PTY (Bun.Terminal, Bun 1.4.2): no
// node-pty, no native addon, no helper binary.
//
// `detached: true` is not optional. Without it the child shares Bun's session and the PTY
// never becomes its controlling terminal (macOS `ps` shows TT `??`): `sh` warns "no job
// control", Ctrl-C (ISIG) reaches no foreground process group, and `sleep 30` survives it.
// Detached, Bun calls setsid() and makes the PTY the controlling terminal of the new
// session, as a terminal emulator or tmux does (measured in README.md).

export type PtyOptions = {
  argv: readonly string[];
  cols: number;
  rows: number;
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** Bytes the program wrote: terminal output, to feed an emulator. */
  onData: (bytes: Uint8Array) => void;
  onExit?: (code: number | null) => void;
};

export type Pty = {
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  kill(signal?: NodeJS.Signals): void;
  readonly exited: Promise<number>;
  readonly pid: number;
};

export function spawnPty(options: PtyOptions): Pty {
  const terminal = new Bun.Terminal({
    cols: options.cols,
    rows: options.rows,
    name: "xterm-256color",
    data: (_terminal, bytes) => options.onData(bytes),
  });
  const [command, ...args] = options.argv;
  if (!command) throw new Error("spawnPty: empty argv");
  const child = Bun.spawn([command, ...args], {
    terminal,
    detached: true,
    cwd: options.cwd,
    // TERM must match what the emulator answers to (DA, terminfo); COLORTERM advertises
    // truecolor, which every emulator evaluated here renders.
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", ...options.env },
    onExit: (_child, code) => {
      terminal.close();
      options.onExit?.(code);
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
    kill: (signal = "SIGHUP") => child.kill(signal),
    exited: child.exited,
    pid: child.pid,
  };
}
