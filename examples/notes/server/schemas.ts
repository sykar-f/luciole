import "server-only";
import { z } from "zod";
import type { Note, SaveResult, Snapshot } from "../components/draft";

// Server Function arguments arrive from the network: their TypeScript types describe what
// the Client should send, these schemas what the Server accepts.
export const OperationId = z.string().regex(/^[0-9a-f-]{36}$/, "Invalid operation");
const MAX_ID = 100;
const MAX_TITLE = 120;
export const NoteId = z.string().min(1).max(MAX_ID);
export const Title = z
  .string()
  .trim()
  .max(MAX_TITLE, `A title holds up to ${MAX_TITLE} characters`);
export const SnapshotInput = z.object({
  id: NoteId,
  value: z.string(),
  version: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  operationId: OperationId,
}) satisfies z.ZodType<Snapshot>;

const NoteRecord = z.object({
  id: z.string(),
  title: z.string(),
  value: z.string(),
  version: z.number().int(),
  // Results stored before notes were dated have none.
  updated: z.number().int().default(0),
}) satisfies z.ZodType<Note>;
/** A result stored as JSON in the operations table, read back when resolving it. */
export const StoredResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), note: NoteRecord, operationId: z.string() }),
  z.object({
    ok: z.literal(false),
    error: z.string(),
    operationId: z.string(),
    conflict: z.boolean().optional(),
  }),
]) satisfies z.ZodType<SaveResult>;
