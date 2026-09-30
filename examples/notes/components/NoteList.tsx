"use client";
import { useRef } from "react";
import type { MouseEvent, SelectRenderable } from "@opentui/core";
import { useNavigate } from "luciole/client";
import type { Note } from "./draft";

/** A title, then its first line. */
const LINES_PER_NOTE = 2;

/**
 * The note under a click, if any. The select keeps its selected option centred as it
 * scrolls (OpenTUI, renderables/Select.ts): the first visible option follows from it.
 */
function noteAt(select: SelectRenderable, y: number) {
  const visible = Math.max(1, Math.floor(select.height / LINES_PER_NOTE));
  const first = Math.max(
    0,
    Math.min(select.getSelectedIndex() - Math.floor(visible / 2), select.options.length - visible),
  );
  const index = first + Math.floor((y - select.y) / LINES_PER_NOTE);
  return index < select.options.length ? index : undefined;
}

export function NoteList({ notes }: { notes: Note[] }) {
  const navigate = useNavigate();
  const select = useRef<SelectRenderable>(null);
  return (
    <box flexDirection="column" gap={1}>
      <text>YOUR NOTES</text>
      <select
        ref={select}
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
        onMouseDown={(event: MouseEvent) => {
          const index = select.current ? noteAt(select.current, event.y) : undefined;
          if (index === undefined) return;
          select.current?.setSelectedIndex(index);
          select.current?.selectCurrent();
        }}
      />
      <text fg="#8b98a5">↑ ↓ choose · Enter or click open</text>
    </box>
  );
}
