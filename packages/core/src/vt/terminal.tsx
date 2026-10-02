/** @jsxImportSource @opentui/react */
/**
 * `<Terminal>`: a local program (a shell, vim, another luciole Client) on a PTY, rendered
 * in the application's tree: the `process` mode of docs/EMBEDDING.md. No isolation: the
 * program runs with the user's rights, as in tmux.
 *
 * The emulator is OpenTUI's EmbeddedTerminalRenderable (libghostty-vt inside libopentui):
 * parsing, the cell grid, key/mouse/paste/focus encoding and most query answers are
 * native, and the grid is composed straight into the frame (measured 12–20 times
 * cheaper than drawing cells from React). gaps.ts fills what 0.5.12 misses.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import type { BoxRenderable, KeyEvent } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useKeymap } from "@opentui/keymap/react";
import { messageOf } from "../guards";
import { spawnPty, type Pty, type PtyOptions } from "./pty";
import { queryResponder, VtTerminalRenderable, type Palette } from "./gaps";

// The renderable's own colors (white on black), reported to programs that ask.
const FULL = 0xff;
const PALETTE: Palette = { fg: [FULL, FULL, FULL], bg: [0, 0, 0] };

export type TerminalProps = {
  /** The program and its arguments, started on the first layout at the pane's size. */
  command: readonly string[];
  /** Whether this terminal has the keys: it takes the focus, the host decides when. */
  active: boolean;
  /**
   * The host's key (keymap syntax, `"ctrl+o"`): it and the sequence it starts are left
   * to the application's bindings (`"ctrl+oo"`: Ctrl+O, then O); a prefix nothing binds reaches the
   * program. Every other key, Ctrl+C included, goes to the program while the terminal
   * is active. Without a prefix, only moving the focus (`active`, a click) gives the
   * keys back.
   */
  prefix?: string;
  cwd?: string;
  /** Added to the Client's environment; `TERM` is `xterm-256color`. */
  env?: Record<string, string | undefined>;
  /** The program ended (`null`: killed by a signal). Its last screen stays shown. */
  onExit?: (code: number | null) => void;
  /** Lines kept above the screen. */
  scrollback?: number;
  id?: string;
  flexGrow?: number;
  width?: number | `${number}%`;
  height?: number | `${number}%`;
};

/** What `TerminalView` hands the function that starts its program. */
export type TerminalIo = Pick<PtyOptions, "cols" | "rows" | "onData" | "onExit">;
/**
 * `<Terminal>` with its own way of starting the program (the sandbox starts it under
 * Seatbelt, src/sandbox/spawn.ts; a host may end it otherwise than by SIGHUP).
 * `program` identifies the program: a new one replaces the running one.
 */
export type TerminalViewProps = Omit<TerminalProps, "command" | "cwd" | "env"> & {
  program: string;
  spawn: (io: TerminalIo) => Pty;
  /** What the program's name is in an error line. */
  label: string;
};

export function Terminal(props: TerminalProps) {
  const { command, cwd, env, ...view } = props;
  return (
    <TerminalView
      {...view}
      program={JSON.stringify(command)}
      label={command.join(" ")}
      spawn={(io) => spawnPty({ ...io, command, cwd, env })}
    />
  );
}

export function TerminalView(props: TerminalViewProps) {
  const renderer = useRenderer();
  const keymap = useKeymap();
  const host = useRef<BoxRenderable>(null);
  const view = useRef<VtTerminalRenderable | null>(null);
  // Callbacks and options change on every render; the program lives as long as its
  // command, so it reads the latest ones.
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  const command = props.program;
  useLayoutEffect(() => {
    const box = host.current;
    if (!box) return;
    let pty: Pty | undefined;
    let failed = false;
    const respond = queryResponder(PALETTE);
    const terminal = new VtTerminalRenderable(renderer, {
      id: latest.current.id,
      width: "100%",
      height: "100%",
      maxScrollback: latest.current.scrollback,
      // Encoded keys, mouse and paste, and native answers to the program's queries.
      onData: (bytes) => pty?.write(bytes),
      // The layout decides the size. The program starts on the first layout: a shell
      // started at 80x24 and then resized has already drawn its prompt for the wrong width.
      onTerminalResize: (cols, rows) => {
        if (pty) return pty.resize(cols, rows);
        if (failed) return;
        try {
          pty = start(cols, rows);
        } catch (error: unknown) {
          // A missing program is the user's input, not a crash of the tree: say it in the
          // pane, as a terminal would, and report the end.
          failed = true;
          terminal.write(`${latest.current.label}: ${messageOf(error)}\r\n`);
          latest.current.onExit?.(null);
        }
      },
    });
    const start = (cols: number, rows: number) =>
      latest.current.spawn({
        cols,
        rows,
        onData: (bytes) => {
          if (!terminal.isDestroyed) terminal.write(bytes);
          // A program that asks and never hears back hangs or guesses.
          const answers = respond(bytes);
          if (answers) pty?.write(answers);
        },
        onExit: (code) => latest.current.onExit?.(code),
      });
    box.add(terminal);
    view.current = terminal;
    return () => {
      pty?.kill();
      view.current = null;
      terminal.destroy();
    };
  }, [renderer, command]);
  useEffect(() => {
    const terminal = view.current;
    if (!terminal) return;
    // Focus reporting (CSI I / CSI O) is sent by the renderable when the program asked.
    if (props.active) terminal.focus();
    else terminal.blur();
  }, [props.active, command]);
  // The application's keymap sees keys before the focused renderable: its bindings (`j`,
  // Escape, Ctrl+C to quit) would take them from the program. While this terminal has the
  // focus, it takes every key first, except the host's prefix and the sequence it starts.
  // Handled here and consumed, a key reaches neither the keymap's layers nor run()'s own
  // Ctrl+C listener, and the renderable does not receive it a second time.
  const prefix = props.prefix;
  useEffect(() => {
    if (!props.active) return;
    const isPrefix = prefix ? keymap.createKeyMatcher(prefix) : () => false;
    return keymap.intercept("key", (context: { event: KeyEvent; consume: () => void }) => {
      const terminal = view.current;
      if (!terminal || renderer.currentFocusedRenderable !== terminal) return;
      if (keymap.hasPendingSequence() || isPrefix(context.event)) return;
      terminal.handleKeyPress(context.event);
      context.consume();
    });
  }, [keymap, renderer, props.active, prefix]);
  return <box ref={host} flexGrow={props.flexGrow} width={props.width} height={props.height} />;
}
