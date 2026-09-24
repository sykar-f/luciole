import { z } from "zod";

/** The JSON line child.ts prints: whether the action succeeded, and why. */
export const ChildResult = z.object({ ok: z.boolean(), detail: z.string() });
export type ChildResult = z.infer<typeof ChildResult>;

/** What probe.ts reads back from linux-run.ts: each case's verdict. */
export const LinuxSummary = z.object({
  cases: z.array(z.object({ name: z.string(), pass: z.boolean() })),
});
