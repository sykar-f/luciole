"use server";
import { save, operation } from "../server/repository";
import type { Snapshot, SaveResult } from "airtty/client";
export async function saveNote(snapshot: Snapshot): Promise<SaveResult> {
  await Bun.sleep(Number(process.env.NOTES_DELAY_MS ?? 0));
  return save(snapshot);
}
export async function getOperation(id: string): Promise<SaveResult | null> {
  return operation(id);
}
