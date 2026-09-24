/** @jsxImportSource @opentui/react */
// Manual demo, in a real terminal: `bun demo.tsx [left command] [right command]`.
// Left: your $SHELL; right: vim on this file (or a second shell without vim).
// Ctrl-O moves the focus, a click focuses a pane, Ctrl-Q quits; everything else goes to
// the focused program, mouse included when it asks for it (try `:set mouse=a` in vim).
import { useState } from "react";
import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer } from "@opentui/react";
import { VtView } from "./vt-view";

const shell = process.env.SHELL ?? "/bin/sh";
const hasVim = Bun.which("vim") !== null;
const left = [process.argv[2] ?? shell];
const right = process.argv[3] ? [process.argv[3]] : hasVim ? ["vim", import.meta.path] : [shell];
type Pane = "left" | "right";

function Demo() {
  const renderer = useRenderer();
  const [focus, setFocus] = useState<Pane>("left");
  const [exited, setExited] = useState<Record<Pane, number | null | undefined>>({
    left: undefined,
    right: undefined,
  });
  useKeyboard((key) => {
    if (!key.ctrl) return;
    // Host keys are global listeners: they run before the focused terminal, and
    // preventDefault() keeps them out of its PTY.
    if (key.name === "o") {
      key.preventDefault();
      setFocus((f) => (f === "left" ? "right" : "left"));
    }
    if (key.name === "q") {
      key.preventDefault();
      renderer.destroy();
      process.exit(0);
    }
  });
  const status = (pane: Pane) => (exited[pane] === undefined ? "" : ` [exited ${exited[pane]}]`);
  return (
    <box flexDirection="column" width="100%" height="100%">
      <box flexDirection="row" flexGrow={1}>
        {(["left", "right"] as const).map((pane) => (
          <box key={pane} flexGrow={1} flexDirection="column" onMouseDown={() => setFocus(pane)}>
            <VtView
              id={pane}
              argv={pane === "left" ? left : right}
              focused={focus === pane}
              flexGrow={1}
              onExit={(code) => setExited((e) => ({ ...e, [pane]: code }))}
            />
          </box>
        ))}
      </box>
      <text height={1} fg="#8b98a5">
        Ctrl-O focus · click focus · Ctrl-Q quit · focus: {focus}
        {status("left")}
        {status("right")}
      </text>
    </box>
  );
}

const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: true });
createRoot(renderer).render(<Demo />);
