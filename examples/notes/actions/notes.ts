"use server";
import { getSession, invalidate } from "airtty/server";
import { z } from "zod";
import { save, operation } from "../server/repository";
import { OperationId, SnapshotInput } from "../server/schemas";
import { noteTag, notesTag } from "../server/tags";
import type { Snapshot, SaveResult } from "../components/draft";
// A business-processing probe, not a network simulation: see AIRTTY_LATENCY_MS.
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
// A committed save changes the list and that note's page (title, version): their cached
// reads are dropped, and the Client revalidates only the routes that read them.
async function changed(id: string) {
  const owner = getSession().userId;
  await Promise.all([
    invalidate({ tag: notesTag(owner) }),
    invalidate({ tag: noteTag(owner, id) }),
  ]);
}
