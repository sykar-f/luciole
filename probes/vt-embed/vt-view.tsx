/** @jsxImportSource @opentui/react */
// <VtView>: a program on a PTY, embedded in an OpenTUI tree.
//
// The emulator is OpenTUI's own EmbeddedTerminalRenderable (@opentui/core 0.5.12), which
// wraps libghostty-vt inside libopentui: parsing, the cell grid, key/mouse/paste/focus
// encoding and most query answers stay native, and renderSelf() composes the grid
// straight into the frame buffer (no per-cell JS). bench.ts measures why this path wins
// over a JS emulator (@xterm/headless) or a separate libghostty binding drawn with
// setCell(). gaps.ts patches what 0.5.12 leaves undone (legacy F-keys/Alt/Backspace;
// DA1, DA2, OSC 10/11).
//
// The renderable is created imperatively under a React-owned <box> rather than registered
// with extend(): extend() mutates a process-wide catalogue and needs a global JSX
// augmentation, which a luciole runtime shared by several apps must not impose.
import { useEffect, useLayoutEffect, useRef } from "react";
import type { BoxRenderable, EmbeddedTerminalRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { spawnPty, type Pty } from "./pty";
import { queryResponder, VtTerminalRenderable, type Palette } from "./gaps";

// The renderable's default colors (white on black), reported to programs that ask.
const FULL = 0xff;
const DEFAULT_PALETTE: Palette = { fg: [FULL, FULL, FULL], bg: [0, 0, 0] };

/** Where bytes flow, for tests and tracing: PTY output, user input, emulator answers. */
export type VtTraffic = "output" | "input" | "response";

export type VtViewProps = {
  id: string;
  argv: readonly string[];
  /** Whether keys go to this terminal. The host decides (a prefix key, a click). */
  focused: boolean;
  env?: Record<string, string | undefined>;
  cwd?: string;
  maxScrollback?: number;
  onExit?: (code: number | null) => void;
  onTraffic?: (source: VtTraffic, bytes: Uint8Array) => void;
  /** Exposes the renderable and PTY once both exist (tests, host commands). */
  onReady?: (terminal: EmbeddedTerminalRenderable, pty: Pty) => void;
  flexGrow?: number;
  width?: number | `${number}%`;
  height?: number | `${number}%`;
};

export function VtView(props: VtViewProps) {
  const renderer = useRenderer();
  const host = useRef<BoxRenderable>(null);
  const terminal = useRef<EmbeddedTerminalRenderable | null>(null);
  // Callbacks change every render; the PTY lives as long as argv, so it reads the latest.
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  const command = JSON.stringify(props.argv);
  useLayoutEffect(() => {
    const box = host.current;
    if (!box) return;
    let pty: Pty | undefined;
    const respond = queryResponder(DEFAULT_PALETTE);
    // Bytes the emulator produces: encoded keys/mouse/paste ("input") and answers to the
    // program's queries ("response", e.g. DA1, DSR 6n). Both go back to the PTY: a
    // program that asks for the cursor position and never hears back hangs or guesses.
    const view = new VtTerminalRenderable(renderer, {
      // Creation-time options, like argv: read through `latest`, they do not restart it.
      id: latest.current.id,
      width: "100%",
      height: "100%",
      maxScrollback: latest.current.maxScrollback,
      onData: (bytes, source) => {
        latest.current.onTraffic?.(source, bytes);
        pty?.write(bytes);
      },
      // Layout decides the size: the emulator reflows, then the kernel tells the program.
      // The program starts on the first layout, at its real size: a shell spawned at
      // 80x24 then shrunk has already drawn a prompt for the wrong width.
      onTerminalResize: (cols, rows) => {
        if (pty) return pty.resize(cols, rows);
        pty = spawnPty({
          argv: latest.current.argv,
          cols,
          rows,
          env: latest.current.env,
          cwd: latest.current.cwd,
          onData: (bytes) => {
            latest.current.onTraffic?.("output", bytes);
            if (!view.isDestroyed) view.write(bytes);
            const answers = respond(bytes);
            if (!answers) return;
            latest.current.onTraffic?.("response", Buffer.from(answers, "latin1"));
            pty?.write(answers);
          },
          onExit: (code) => latest.current.onExit?.(code),
        });
        latest.current.onReady?.(view, pty);
      },
    });
    box.add(view);
    terminal.current = view;
    return () => {
      pty?.kill();
      terminal.current = null;
      view.destroy();
    };
    // The command identifies the session; other props are read through `latest`.
  }, [renderer, command]);
  useEffect(() => {
    const view = terminal.current;
    if (!view) return;
    // Focus reporting (CSI I / CSI O) is emitted by the renderable when the program asked.
    if (props.focused) view.focus();
    else view.blur();
  }, [props.focused, command]);
  return (
    <box
      ref={host}
      flexGrow={props.flexGrow}
      width={props.width}
      height={props.height}
      border
      borderColor={props.focused ? "#67d9bc" : "#526d82"}
      title={props.argv.join(" ")}
    />
  );
}
