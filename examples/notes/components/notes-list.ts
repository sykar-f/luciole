"use client";
import { useEffect, useSyncExternalStore } from "react";
import { TransportError, useInvalidation } from "@luciole-sh/core/client";
import { listNotes } from "../actions/notes";
import type { Note } from "./draft";

// The sidebar's notes. Layouts are Client Components: the list is read through a Server
// Function, then read again whenever a change invalidates cached reads.

type State = { notes: readonly Note[] | null; error: string };
let state: State = { notes: null, error: "" };
let loading: Promise<void> | undefined;
let again = false;
const listeners = new Set<() => void>();
function set(next: State) {
  state = next;
  for (const listener of listeners) listener();
}

export const notesList = {
  get: () => state,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** Reads the list; a reload asked while one runs follows it rather than racing it. */
  load(): Promise<void> {
    if (loading) {
      again = true;
      return loading;
    }
    loading = (async () => {
      try {
        set({ notes: await listNotes(), error: "" });
      } catch (error: unknown) {
        // What was shown stays shown: an offline notebook can still be read.
        set({
          notes: state.notes,
          error:
            error instanceof TransportError && error.outcome === "not-sent"
              ? "Server unreachable"
              : "Could not load the notes",
        });
      } finally {
        loading = undefined;
        if (again) {
          again = false;
          void notesList.load();
        }
      }
    })();
    return loading;
  },
  /** Removes a note at once, before the Server's list confirms it. */
  forget(id: string) {
    if (state.notes) set({ ...state, notes: state.notes.filter((note) => note.id !== id) });
  },
};

/** The list, loaded on mount and after every invalidation. */
export function useNotesList() {
  useEffect(() => {
    void notesList.load();
  }, []);
  useInvalidation(() => void notesList.load());
  return useSyncExternalStore(notesList.subscribe, notesList.get);
}
/** The list as it is, without loading it. */
export const useKnownNotes = () => useSyncExternalStore(notesList.subscribe, notesList.get);
