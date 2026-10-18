"use client";
import { useRenderer } from "@opentui/react";
import {
  CapabilityDenied,
  host,
  TransportError,
  useNavigate,
  useParams,
} from "@luciole-sh/core/client";
import { createNote, deleteNote, restoreNote } from "../actions/notes";
import { drafts, type Note } from "./draft";
import { notesList } from "./notes-list";
import { reportError, ui } from "./ui-state";

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
  const renderer = useRenderer();
  const { id: shown } = useParams({ strict: false });
  const open = (id: string) => navigate({ to: "/notes/$id", params: { id } });
  /** The text as typed here, saved or not: what the user sees is what is copied. */
  const copy = async (note: Note) => {
    const text = drafts.unsaved().find((d) => d.id === note.id)?.value ?? note.value;
    try {
      await host.clipboard.write(text);
      ui.toast({ text: "Copied as Markdown" });
      return;
    } catch (error: unknown) {
      if (error instanceof CapabilityDenied) {
        ui.toast({ text: "The clipboard is not available here" });
        return;
      }
    }
    const copied =
      !renderer.isDestroyed && renderer.isOsc52Supported() && renderer.copyToClipboardOSC52(text);
    ui.toast({ text: copied ? "Copied as Markdown" : "The clipboard is not available here" });
  };
  const commands = {
    open: (id: string) => {
      open(id).catch(reportError);
    },
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
      if (id !== shown) open(id).catch(reportError);
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
        notesList.load().catch(reportError);
        ui.toast({ text: `Could not delete: ${failure(error)}` });
        return;
      }
      ui.toast({
        text: `Deleted “${titleOf(note)}”`,
        action: {
          label: "Undo",
          run: () =>
            restoreNote(note.id)
              .then(() => open(note.id))
              .catch((error: unknown) =>
                ui.toast({ text: `Could not restore: ${failure(error)}` }),
              ),
        },
      });
    },
    copy: (note: Note) => {
      copy(note).catch(reportError);
    },
    /** A note's menu, the same from its row in the list and from its page. */
    menu: (note: Note, x: number, y: number) =>
      ui.openMenu({
        x,
        y,
        items: [
          ...(note.id === shown ? [] : [{ label: "Open", run: () => commands.open(note.id) }]),
          { label: "Rename…", run: () => commands.rename(note.id) },
          { label: "Copy as Markdown", run: () => commands.copy(note) },
          { label: "Delete", danger: true, run: () => commands.remove(note).catch(reportError) },
        ],
      }),
  };
  return commands;
}
