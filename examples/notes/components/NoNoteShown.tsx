"use client";
import { useCommands } from "./commands";
import { useKnownNotes } from "./notes-list";
import { usePalette } from "./theme";
import { Button, Line } from "./ui";

/** The right side with no note open: what the list holds, and how to start one. */
export function NoNoteShown() {
  const color = usePalette();
  const commands = useCommands();
  const { notes } = useKnownNotes();
  const count = notes?.length ?? 0;
  return (
    <box
      id="no-note"
      flexDirection="column"
      flexGrow={1}
      alignItems="center"
      justifyContent="center"
      gap={1}
    >
      <Line fg={color.text} bold>
        No note selected
      </Line>
      <Line fg={color.muted}>
        {count ? "Choose one in the list, or start a new one." : "Start your first note."}
      </Line>
      <Button tone="primary" onPress={() => void commands.create()}>
        + New note
      </Button>
    </box>
  );
}
