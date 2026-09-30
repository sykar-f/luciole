"use client";
import { TransportError, useNavigate, useParams } from "luciole/client";
import { createNote, deleteNote, restoreNote } from "../actions/notes";
import type { Note } from "./draft";
import { notesList } from "./notes-list";
import { ui } from "./ui-state";

/** A title to show: a blank one reads as such. */
export const titleOf = (note: Pick<Note, "title">) => note.title.trim() || "Untitled";

function failure(error: unknown) {
  return error instanceof TransportError && error.outcome === "not-sent"
    ? "the Server is unreachable"
    : error instanceof Error
      ? error.message
      : "unknown error";
}

/** What the sidebar, the menus and the note itself can do to notes. */
export function useCommands() {
  const navigate = useNavigate();
  const { id: shown } = useParams({ strict: false });
  const open = (id: string) => navigate({ to: "/notes/$id", params: { id } });
  return {
    open: (id: string) => void open(id),
    /** A blank note, opened with its title ready to type. */
    create: async () => {
      try {
        const note = await createNote();
        ui.rename(note.id);
        await open(note.id);
      } catch (error: unknown) {
        ui.toast({ text: `Could not create a note: ${failure(error)}` });
      }
    },
    rename: (id: string) => {
      ui.rename(id);
      if (id !== shown) void open(id);
    },
    /** Deleted at once, with an Undo: nothing asks "are you sure?". */
    remove: async (note: Note) => {
      const notes = notesList.get().notes ?? [];
      const at = notes.findIndex((n) => n.id === note.id);
      const next = notes[at + 1] ?? notes[at - 1];
      notesList.forget(note.id);
      if (note.id === shown) await (next ? open(next.id) : navigate({ to: "/" }));
      try {
        await deleteNote(note.id);
      } catch (error: unknown) {
        void notesList.load();
        ui.toast({ text: `Could not delete: ${failure(error)}` });
        return;
      }
      ui.toast({
        text: `Deleted “${titleOf(note)}”`,
        action: {
          label: "Undo",
          run: () =>
            void restoreNote(note.id).then(
              () => open(note.id),
              (error: unknown) => ui.toast({ text: `Could not restore: ${failure(error)}` }),
            ),
        },
      });
    },
  };
}
