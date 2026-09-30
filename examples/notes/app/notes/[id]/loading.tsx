"use client";
import type { LoadingProps } from "luciole/client";
import { titleOf } from "../../../components/commands";
import { NotePane } from "../../../components/NoteFrame";
import { useKnownNotes } from "../../../components/notes-list";
import { Pulse } from "../../../components/Pulse";
import { usePalette } from "../../../components/theme";
import { Line } from "../../../components/ui";

// The list already knows the note's title: the page opens with it while the Server
// renders the rest. The layout stays mounted; only this slot is replaced.
export default function Loading({ params }: LoadingProps) {
  const color = usePalette();
  const { notes } = useKnownNotes();
  const known = notes?.find((note) => note.id === params.id);
  return (
    <NotePane
      toolbar={<Line fg={color.muted}>Opening…</Line>}
      title={
        <Line fg={color.accent} bold>
          {known ? titleOf(known) : "Opening note…"}
        </Line>
      }
    >
      <Pulse>
        <Line id="note-placeholder" fg={color.muted}>
          Loading the note…
        </Line>
      </Pulse>
    </NotePane>
  );
}
