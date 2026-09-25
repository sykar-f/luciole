/**
 * The interactive proof (docs/WEB.md, R1): @opentui/react on opentui.wasm, with an
 * <input> fed by keystrokes, a <scrollbox> of what was submitted, and a key binding. The
 * renderer reads this process's stdin and writes its stdout through NativeSpanFeed, as
 * a browser terminal will.
 */
import "./setup-bun";
import { useState } from "react";
import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer } from "@opentui/react";
import { isInputStream, terminalOutput } from "./streams";

const SIZE = { columns: 60, rows: 14 };

function Form() {
  const renderer = useRenderer();
  // A new <input> per note: the submitted value comes from onSubmit, and remounting
  // clears it (a controlled `value` stops following keystrokes once reset, natively too).
  const [round, setRound] = useState(0);
  const [notes, setNotes] = useState<readonly string[]>([]);
  useKeyboard((key) => {
    if (key.name === "escape") {
      renderer.destroy();
      process.exit(0);
    }
  });
  return (
    <box flexDirection="column" border borderStyle="rounded" title="notes.wasm" padding={1}>
      <input
        key={round}
        focused
        placeholder="Type a note, Enter to add"
        onSubmit={(submitted: unknown) => {
          // @opentui/react passes the value; the renderable's own type says an event.
          if (typeof submitted !== "string") return;
          setNotes((all) => [...all, submitted]);
          setRound((n) => n + 1);
        }}
      />
      <scrollbox height={6}>
        {notes.map((note, i) => (
          <text key={i}>{`${i + 1}. ${note}`}</text>
        ))}
      </scrollbox>
      <text>{`${notes.length} note(s) · Esc quits`}</text>
    </box>
  );
}

const stdin = process.stdin;
if (!isInputStream(stdin)) throw new Error("unreachable: process.stdin is readable");
const renderer = await createCliRenderer({
  stdin,
  stdout: terminalOutput(SIZE, (chunk, done) => process.stdout.write(chunk, done)),
  width: SIZE.columns,
  height: SIZE.rows,
  useThread: false,
  exitOnCtrlC: false,
  exitSignals: [],
});
createRoot(renderer).render(<Form />);
