/**
 * How studio drives a harness, shared by the studio (server/studio.ts) and by the
 * measurement of real harnesses (scripts/studio/measure.ts): which adapter, which one
 * when none is asked for, and what every start receives.
 */
import { createHarness } from "@airtty/harness/adapters";
import type { Harness, HarnessContext, HarnessStatus } from "@airtty/harness/adapters/types";
import { detect } from "@airtty/harness/detect";
import { HARNESS_NAMES, type HarnessId } from "@airtty/harness/model";
import type { HarnessSessionOptions } from "@airtty/harness/session";
import { Generator } from "./generator";
import { INSTRUCTIONS } from "./instructions";

// The only tools Claude Code gets: read and write files, search. No shell, no web.
export const TOOLS = ["Read", "Write", "Edit", "Glob", "Grep"] as const;
// Without --harness: Claude Code (Codex, pi and opencode are coder's only).
const AUTO_ORDER: readonly HarnessId[] = ["claude"];

/** The adapter: studio's scripted generator for `fake`, the shared ones otherwise. */
export const create = (id: HarnessId, context: HarnessContext): Harness =>
  id === "fake" ? new Generator(context) : createHarness(id, context);

/** Which harness runs: the one asked for, or Claude Code when it is ready. */
export async function pick(wanted: HarnessId | undefined): Promise<HarnessStatus> {
  if (wanted) return detect(wanted);
  const found = await Promise.all(AUTO_ORDER.map((id) => detect(id)));
  const ready = found.find((status) => status.ready);
  if (ready) return ready;
  throw new Error(
    `No harness is ready: ${found
      .map(
        (s) =>
          `${HARNESS_NAMES[s.id]}: ${s.installed ? (s.fix ?? "not signed in") : "not installed"}`,
      )
      .join("; ")}. Try --harness fake for the scripted generator.`,
  );
}

/** What every start of the harness receives: studio's name, instructions and tools. */
export const START: NonNullable<HarnessSessionOptions["start"]> = {
  client: "airtty-studio",
  instructions: INSTRUCTIONS,
  tools: TOOLS,
  isolated: true,
};
