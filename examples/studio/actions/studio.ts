"use server";
import { z } from "zod";
import type { FilePatch, RequestState, Result, Update } from "@luciole/harness/model";
import type { StudioSnapshot } from "../components/model";
import { studio } from "../server/studio";

// Arguments arrive decoded but unchecked: each one is validated here.
const PROMPT_MAX = 100_000;
const NAME_MAX = 200;
const OPTIONS_MAX = 50;
const QUESTIONS_MAX = 20;
const MESSAGE_MAX = 4000;
const Text = z.string().trim().min(1).max(PROMPT_MAX);
const Id = z.string().min(1).max(NAME_MAX);
const Revision = z.number().int().min(0);
const Host = z
  .string()
  .regex(/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i);
const Answers = z.array(z.array(z.string().max(PROMPT_MAX)).max(OPTIONS_MAX)).max(QUESTIONS_MAX);
const Response = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("approval"),
    decision: z.enum(["once", "session", "always", "deny"]),
  }),
  z.object({ kind: z.literal("question"), answers: Answers }),
  z.object({
    kind: z.literal("plan_review"),
    approve: z.boolean(),
    feedback: z.string().max(PROMPT_MAX).optional(),
  }),
  z.object({ kind: z.literal("cancel") }),
]);
const invalid = (what: string): Result => ({ ok: false, error: `Invalid ${what}` });
const failed = (error: unknown): Result => ({
  ok: false,
  error: error instanceof Error ? error.message : String(error),
});

/**
 * The harness session, live: a snapshot, then patches. The argument only renews the
 * subscription (a gap in the patches).
 */
export async function feed(_attempt: number): Promise<AsyncIterable<Update>> {
  await studio.open();
  return studio.session.subscribe();
}

/** studio's own state: project, revisions, validation, preview (useLive). */
export async function state(): Promise<AsyncIterable<StudioSnapshot>> {
  return studio.subscribe();
}

/** A message from the user: a new request for the harness. */
export async function send(text: unknown): Promise<Result> {
  const parsed = Text.safeParse(text);
  if (!parsed.success) return invalid("message");
  return studio.send(parsed.data);
}

export async function interrupt(): Promise<Result> {
  return studio.session.interrupt();
}

/** Answers a request by its id; answering twice is harmless (the second is dropped). */
export async function respond(id: unknown, response: unknown): Promise<Result> {
  const request = Id.safeParse(id);
  const answer = Response.safeParse(response);
  if (!request.success || !answer.success) return invalid("answer");
  return studio.session.respond(request.data, answer.data);
}

/** Where a request stands: for an answer whose outcome is unknown, instead of a replay. */
export async function requestState(id: unknown): Promise<RequestState> {
  const request = Id.safeParse(id);
  return request.success ? studio.session.requestState(request.data) : { state: "gone" };
}

/** Puts the project back as revision `number` was (a new revision). */
export async function restore(number: unknown): Promise<Result> {
  const parsed = Revision.safeParse(number);
  if (!parsed.success) return invalid("revision");
  // The rebuild runs on; its outcome comes through `state`.
  studio.restore(parsed.data).catch(() => {});
  return { ok: true };
}

/** Starts the preview's Server again, on the same revision. */
export async function restart(): Promise<Result> {
  void studio.restart();
  return { ok: true };
}

/** What revision `number` changed, one patch per file. */
export async function patch(
  number: unknown,
): Promise<{ ok: true; files: FilePatch[] } | { ok: false; error: string }> {
  const parsed = Revision.safeParse(number);
  if (!parsed.success) return { ok: false, error: "Invalid revision" };
  try {
    return { ok: true, files: await studio.patch(parsed.data) };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The user allows the app to reach a network host, or withdraws it. */
export async function allowHost(host: unknown, allowed: unknown): Promise<Result> {
  const parsed = Host.safeParse(host);
  if (!parsed.success || typeof allowed !== "boolean") return invalid("host");
  try {
    await studio.setHost(parsed.data.toLowerCase(), allowed);
    return { ok: true };
  } catch (error: unknown) {
    return failed(error);
  }
}

/** A page of the preview failed (its Client says so over IPC): studio corrects it. */
export async function previewFailed(
  revision: unknown,
  path: unknown,
  message: unknown,
): Promise<Result> {
  const r = Revision.safeParse(revision);
  const p = z.string().max(NAME_MAX).safeParse(path);
  const m = z.string().max(MESSAGE_MAX).safeParse(message);
  if (!r.success || !p.success || !m.success) return invalid("failure");
  studio.reportFailure(r.data, p.data, m.data);
  return { ok: true };
}
