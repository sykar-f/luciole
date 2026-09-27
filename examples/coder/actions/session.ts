"use server";
import { z } from "zod";
import {
  MODES,
  type RequestState,
  type Result,
  type SessionSummary,
  type Update,
} from "@airtty/harness/model";
import { config } from "../server/config";
import { findFiles } from "../server/files";
import { session } from "../server/session";

// Arguments arrive decoded but unchecked: each one is validated here.
const PROMPT_MAX = 100_000;
const Text = z.string().trim().min(1).max(PROMPT_MAX);
const NAME_MAX = 200;
const OPTIONS_MAX = 50;
const QUESTIONS_MAX = 20;
const Id = z.string().min(1).max(NAME_MAX);
const Name = z.string().min(1).max(NAME_MAX);
const Query = z.string().max(NAME_MAX);
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

/** A message: a new turn, or (while one runs) injected or queued. */
export async function send(text: unknown, queue: unknown): Promise<Result> {
  const parsed = Text.safeParse(text);
  if (!parsed.success) return invalid("message");
  return session.send(parsed.data, { queue: queue === true });
}

export async function interrupt(): Promise<Result> {
  return session.interrupt();
}

/** Answers a request by its id; answering twice is harmless (the second is dropped). */
export async function respond(id: unknown, response: unknown): Promise<Result> {
  const request = Id.safeParse(id);
  const answer = Response.safeParse(response);
  if (!request.success || !answer.success) return invalid("answer");
  return session.respond(request.data, answer.data);
}

/** Where a request stands: for an answer whose outcome is unknown, instead of a replay. */
export async function requestState(id: unknown): Promise<RequestState> {
  const request = Id.safeParse(id);
  return request.success ? session.requestState(request.data) : { state: "gone" };
}

export async function setModel(model: unknown, effort: unknown): Promise<Result> {
  const m = Name.safeParse(model);
  const e = Name.optional().safeParse(effort ?? undefined);
  if (!m.success || !e.success) return invalid("model");
  return session.setModel(m.data, e.data);
}

export async function setEffort(effort: unknown): Promise<Result> {
  const e = Name.safeParse(effort);
  return e.success ? session.setEffort(e.data) : invalid("effort");
}

export async function setMode(mode: unknown): Promise<Result> {
  const m = z.enum(MODES).safeParse(mode);
  return m.success ? session.setMode(m.data) : invalid("mode");
}

export async function compact(): Promise<Result> {
  return session.compact();
}

export async function newSession(): Promise<Result> {
  return session.newSession();
}

export async function resume(id: unknown): Promise<Result> {
  const s = Id.safeParse(id);
  return s.success ? session.resume(s.data) : invalid("session");
}

export async function listSessions(): Promise<
  { ok: true; sessions: readonly SessionSummary[] } | { ok: false; error: string }
> {
  return session.listSessions();
}

/** Project files matching `query`, for `@file` completion. */
export async function files(query: unknown): Promise<readonly string[]> {
  const q = Query.safeParse(query);
  return q.success ? findFiles(config.cwd, q.data) : [];
}

/**
 * The session, live: a snapshot at once, then what changed. `useLive` keeps it open
 * while the screen is mounted; the argument only renews the subscription (Ctrl+R).
 */
export async function feed(_attempt: number): Promise<AsyncIterable<Update>> {
  void session.start();
  return session.subscribe();
}
