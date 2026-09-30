import { z } from "zod";
import { messageOf } from "./guards";

// Bun rejects a failed build with an AggregateError whose own message is only "Bundle failed".
const AggregateFailure = z.object({ errors: z.array(z.unknown()) });

/** What a rejected `Bun.build` says, one message per error. */
export function bundleMessages(error: unknown): string[] {
  const failure = AggregateFailure.safeParse(error);
  const messages = failure.success ? failure.data.errors.map(messageOf) : [];
  return messages.length ? messages : [messageOf(error)];
}

/** The logs of an unsuccessful `Bun.build` result. */
export const logMessages = (logs: readonly { message: string }[]) =>
  logs.map((log) => log.message).join("\n");
