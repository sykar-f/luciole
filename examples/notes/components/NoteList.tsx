"use client";
import { useNavigation, type Note } from "@terminal/framework/client";
export function NoteList({ notes }: { notes: Note[] }) {
  const { navigate } = useNavigation();
  return (
    <box flexDirection="column" gap={1}>
      <text>YOUR NOTES</text>
      <select
        id="notes"
        focused
        height={6}
        options={notes.map((note) => ({
          name: note.title,
          description: note.value || "Empty note",
          value: note.id,
        }))}
        onSelect={(_index, option) => {
          if (option) void navigate(`/notes/${option.value}`);
        }}
      />
      <text fg="#8b98a5">↑ ↓ choose · Enter open</text>
    </box>
  );
}
