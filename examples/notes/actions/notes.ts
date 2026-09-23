"use server";
import { invalidate } from "airtty/server";
import { z } from "zod";
import { save, operation } from "../server/repository";
import { OperationId, SnapshotInput } from "../server/schemas";
import type { Snapshot, SaveResult } from "../components/draft";
// A business-processing probe, not a network simulation: see AIRTTY_LATENCY_MS.
const delayMs = z.coerce.number().nonnegative().default(0).parse(process.env.NOTES_DELAY_MS);
export async function saveNote(snapshot: Snapshot): Promise<SaveResult> {
  const input = SnapshotInput.parse(snapshot);
  await Bun.sleep(delayMs);
  const result = save(input);
  // A committed save changes the list and the page (title, version).
  if (result.ok) invalidate();
  return result;
}
export async function getOperation(id: string): Promise<SaveResult | null> {
  const result = operation(OperationId.parse(id));
  if (result?.ok) invalidate();
  return result;
}
