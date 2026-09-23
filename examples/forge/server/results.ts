import { z } from "zod";
import type { Note } from "../components/draft";
import type { OperationResult, PublishResult } from "../components/model";

// The ledger stores results as JSON; these schemas restore the type of each operation kind.
const NoteRecord = z.object({
  id: z.string(),
  title: z.string(),
  value: z.string(),
  version: z.number().int(),
}) satisfies z.ZodType<Note>;

/** A document save or a composer publication (`number` names a new pull request). */
export const PublishResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    note: NoteRecord,
    operationId: z.string(),
    number: z.number().int().optional(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.string(),
    operationId: z.string(),
    number: z.number().int().optional(),
  }),
]) satisfies z.ZodType<PublishResult>;

export const OperationResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), operationId: z.string(), message: z.string() }),
  z.object({ ok: z.literal(false), operationId: z.string(), error: z.string() }),
]) satisfies z.ZodType<OperationResult>;
