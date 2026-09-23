"use server";
import { invalidate } from "airtty/server";
import { save, operation } from "../server/repository";
import type { Snapshot, SaveResult } from "../components/draft";
export async function saveNote(snapshot: Snapshot): Promise<SaveResult> {
  await Bun.sleep(Number(process.env.NOTES_DELAY_MS ?? 0));
  const result = save(snapshot);
  // A committed save changes the list and the page (title, version).
  if (result.ok) invalidate();
  return result;
}
export async function getOperation(id: string): Promise<SaveResult | null> {
  const result = operation(id);
  if (result?.ok) invalidate();
  return result;
}
