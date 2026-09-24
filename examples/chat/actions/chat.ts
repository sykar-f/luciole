"use server";
import { z } from "zod";
import type { ChatEvent } from "../components/model";
import { complete } from "../server/openrouter";

// Arguments arrive decoded but unchecked: the history is validated before any request.
const MAX_TURNS = 200,
  MAX_CHARS = 60_000;
const History = z
  .array(
    z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string().max(MAX_CHARS),
    }),
  )
  .min(1)
  .max(MAX_TURNS)
  .refine((history) => history.at(-1)?.role === "user", "The last turn must be the user's");

/**
 * One reply, streamed while the Client keeps it open (`useLive`). Leaving (Esc, quit)
 * closes the generator, which aborts the OpenRouter request.
 */
export async function* reply(history: unknown): AsyncGenerator<ChatEvent> {
  const parsed = History.safeParse(history);
  if (!parsed.success) {
    yield { type: "error", message: "Invalid conversation history" };
    return;
  }
  yield* complete(parsed.data);
}
