/**
 * The notes form both probes render (docs/WEB.md, R1): an <input> fed by keystrokes, a
 * <scrollbox> of what was submitted, and Escape to quit, which the host decides the
 * meaning of (exit the process, or end the page's terminal).
 */
import { useState } from "react";
import { useKeyboard } from "@opentui/react";

export function Form({ onQuit }: { onQuit: () => void }) {
  // A new <input> per note: the submitted value comes from onSubmit, and remounting
  // clears it (a controlled `value` stops following keystrokes once reset, natively too).
  const [round, setRound] = useState(0);
  const [notes, setNotes] = useState<readonly string[]>([]);
  useKeyboard((key) => {
    if (key.name === "escape") onQuit();
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
