/**
 * One application binary on a PTY, its screen streamed to a window's terminal view.
 * Nothing here knows Electrobun: the host wires `send` and the view's messages.
 *
 * The program runs under `LUCIOLE_DESKTOP=1` (docs/DESKTOP.md): Ctrl+C is the
 * application's, and `hangUp()`, what closing the window does, is the user's quit.
 *
 * Never under `BUN_BE_BUN`: in a single-runtime bundle (scripts/single-runtime.ts) the
 * host is the app binary acting as Bun, and the app it starts must be itself again.
 */
import { spawnPty, type Pty } from "luciole/pty";

export type Size = { cols: number; rows: number };

export type WindowSessionOptions = {
  command: readonly string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** The program's output, decoded, a batch per event loop turn. */
  send: (data: string) => void;
  onExit: (code: number | null) => void;
};
export type WindowSession = {
  /** Starts the program at the view's size; later calls are ignored. */
  open(size: Size): void;
  /** Text, written as UTF-8; `binary`: one byte per character. */
  input(data: string, binary?: boolean): void;
  resize(size: Size): void;
  /** The window closed: the program receives the hangup a terminal sends. */
  hangUp(): void;
};

export function createWindowSession(options: WindowSessionOptions): WindowSession {
  let pty: Pty | undefined;
  let ended = false;
  // A read may end inside a UTF-8 sequence: the decoder keeps it for the next one.
  const decoder = new TextDecoder();
  // A frame arrives in several reads; one message per turn keeps the view's work small.
  let pending = "";
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    const data = pending;
    pending = "";
    if (data) options.send(data);
  };
  return {
    open(size) {
      if (pty || ended) return;
      pty = spawnPty({
        command: options.command,
        cols: size.cols,
        rows: size.rows,
        cwd: options.cwd,
        env: { ...options.env, LUCIOLE_DESKTOP: "1", BUN_BE_BUN: undefined },
        onData: (bytes) => {
          pending += decoder.decode(bytes, { stream: true });
          if (scheduled) return;
          scheduled = true;
          setImmediate(flush);
        },
        onExit: (code) => {
          ended = true;
          pending += decoder.decode();
          flush();
          options.onExit(code);
        },
      });
    },
    input: (data, binary) =>
      pty?.write(binary ? Uint8Array.from(data, (char) => char.charCodeAt(0)) : data),
    resize: (size) => pty?.resize(size.cols, size.rows),
    hangUp: () => pty?.kill(),
  };
}
