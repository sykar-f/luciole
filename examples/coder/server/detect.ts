import "server-only";
import { HARNESS_NAMES, type HarnessId } from "../components/model";
import type { HarnessStatus } from "./adapters/types";

/**
 * Whether each harness can run here, found without asking a model anything: its binary,
 * its version, whether it is signed in. Never a token: only what the harness itself
 * prints about its login (docs/CODER-HANDOFF.md §3).
 */
async function detect(id: HarnessId): Promise<HarnessStatus> {
  switch (id) {
    case "fake":
      return {
        id,
        installed: true,
        ready: true,
        version: "demo",
        account: "demo@example.com",
        warnings: [],
      };
    case "claude":
    case "codex":
    case "pi":
    case "opencode":
      return {
        id,
        installed: Bun.which(id) !== null,
        ready: false,
        fix: `${HARNESS_NAMES[id]} is not supported by this build of coder yet`,
        warnings: [],
      };
  }
}

// Without --harness: the first ready one, in this order (spec §3).
const AUTO_ORDER: readonly HarnessId[] = ["claude", "codex", "opencode", "pi"];

/** The harness of this session: the one asked for, or the first ready one. */
export async function pickHarness(wanted: HarnessId | undefined): Promise<HarnessStatus> {
  if (wanted) return detect(wanted);
  const found = await Promise.all(AUTO_ORDER.map(detect));
  const ready = found.find((status) => status.ready);
  if (ready) return ready;
  throw new Error(
    "No harness is ready: " +
      found
        .map(
          (s) =>
            `${HARNESS_NAMES[s.id]}: ${s.installed ? (s.fix ?? "not signed in") : "not installed"}`,
        )
        .join("; ") +
      ". Try --harness fake for a scripted demo.",
  );
}

export { detect };
