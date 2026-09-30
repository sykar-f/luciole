"use server";
import { getSession, invalidate } from "luciole/server";
import { z } from "zod";
import { notesOf } from "../server/queries";
import { create, operation, remove, rename, restore, save } from "../server/repository";
import { NoteId, OperationId, SnapshotInput, Title } from "../server/schemas";
import { noteTag, notesTag } from "../server/tags";
import type { Note, Snapshot, SaveResult } from "../components/draft";
// A business-processing probe, not a network simulation: see LUCIOLE_LATENCY_MS.
const delayMs = z.coerce.number().nonnegative().default(0).parse(process.env.NOTES_DELAY_MS);

export async function saveNote(snapshot: Snapshot): Promise<SaveResult> {
  const input = SnapshotInput.parse(snapshot);
  await Bun.sleep(delayMs);
  const result = save(input);
  if (result.ok) await changed(result.note.id);
  return result;
}
export async function getOperation(id: string): Promise<SaveResult | null> {
  const result = operation(OperationId.parse(id));
  if (result?.ok) await changed(result.note.id);
  return result;
}
/** The sidebar's notes, newest first: the cached read pages share. */
export async function listNotes(): Promise<Note[]> {
  return notesOf(getSession().userId);
}
export async function createNote(): Promise<Note> {
  const note = create();
  await changed(note.id);
  return note;
}
export async function renameNote(id: string, title: string): Promise<Note> {
  const note = rename(NoteId.parse(id), Title.parse(title));
  await changed(note.id);
  return note;
}
/** Answers the deleted note's id: a Server Function returning nothing is refused by the Client. */
export async function deleteNote(id: string): Promise<string> {
  const note = NoteId.parse(id);
  remove(note);
  await changed(note);
  return note;
}
export async function restoreNote(id: string): Promise<Note> {
  const note = restore(NoteId.parse(id));
  await changed(note.id);
  return note;
}
// A change touches the list (order, title, excerpt) and that note's page: their cached
// reads are dropped, and the Client revalidates only the routes that read them.
async function changed(id: string) {
  const owner = getSession().userId;
  await Promise.all([
    invalidate({ tag: notesTag(owner) }),
    invalidate({ tag: noteTag(owner, id) }),
  ]);
}
