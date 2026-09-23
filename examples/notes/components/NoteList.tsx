"use client";
import { useNavigate } from "airtty/client";
import type { Note } from "./draft";
export function NoteList({ notes }: { notes: Note[] }) {
  const navigate = useNavigate();
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
          if (option) void navigate({ to: "/notes/$id", params: { id: String(option.value) } });
        }}
      />
      <text fg="#8b98a5">↑ ↓ choose · Enter open</text>
    </box>
  );
}
