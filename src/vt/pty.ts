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
export type PtyOptions = {
  command: readonly string[];
  cols: number;
  rows: number;
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** What the program wrote, to feed an emulator. */
  onData: (bytes: Uint8Array) => void;
  onExit: (code: number | null) => void;
};
export type Pty = {
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  readonly pid: number;
};
export function spawnPty(options: PtyOptions): Pty {
  const [program, ...args] = options.command;
  if (!program) throw new Error("A terminal needs a command");
  const terminal = new Bun.Terminal({
    cols: options.cols,
    rows: options.rows,
    name: "xterm-256color",
    data: (_terminal, bytes) => options.onData(bytes),
  });
  const child = Bun.spawn([program, ...args], {
    terminal,
    detached: true,
    cwd: options.cwd,
    // TERM names what the emulator answers to (terminfo, DA); COLORTERM advertises the
    // truecolor it renders.
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", ...options.env },
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
    pid: child.pid,
  };
}
