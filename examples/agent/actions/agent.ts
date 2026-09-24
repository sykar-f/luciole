"use server";
import { z } from "zod";
import type { SendResult, Snapshot } from "../components/model";
import { agent } from "../server/agent";

// A prompt is text typed in one field; anything larger is not from this UI.
const PROMPT_MAX = 20_000;
const Prompt = z.string().trim().min(1).max(PROMPT_MAX);

/** Sends a prompt; while the agent works, it steers the current run instead. */
export async function sendPrompt(message: unknown): Promise<SendResult> {
  const text = Prompt.safeParse(message);
  if (!text.success) return { ok: false, error: "Empty or oversized prompt" };
  return agent.prompt(text.data);
}

export async function abort(): Promise<SendResult> {
  return agent.abort();
}

export async function newSession(): Promise<SendResult> {
  return agent.newSession();
}

/**
 * The conversation, live: the current snapshot at once, then one after each change.
 * `useLive` keeps it open while the screen is mounted. The argument only renews the
 * subscription (Ctrl+R after a lost connection); the Server ignores it.
 */
export async function feed(_attempt: number): Promise<AsyncIterable<Snapshot>> {
  void agent.start().catch(() => {});
  return agent.subscribe();
}
