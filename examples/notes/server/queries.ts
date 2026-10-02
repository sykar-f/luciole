"use cache";
import { cacheTag } from "@luciole-sh/core/server";
import { findNote, listNotes } from "./repository";
import { noteTag, notesTag } from "./tags";

// Shared by every render until a change invalidates their tags (actions/notes.ts). The
// owner is an argument: a cached result must never depend on who asked first.
export async function notesOf(owner: string) {
  cacheTag(notesTag(owner));
  return listNotes(owner);
}
export async function noteOf(owner: string, id: string) {
  cacheTag(noteTag(owner, id));
  return findNote(owner, id);
}
