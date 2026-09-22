import "server-only";
import { getCallId, getSession } from "airtty/server";
import { createForge, type Actor } from "./forge";
import { importGitRepository } from "./git-import";
import { openDatabase } from "./schema";

// The single Forge of this Server process. Pages, Server Functions and the auth
// adapter share it; tests and the operator script build their own from `createForge`.
export const forge = createForge(openDatabase(process.env.FORGE_DB ?? "forge.sqlite"), {
  ciScale: Number(process.env.FORGE_CI_SCALE ?? 1),
  callId: getCallId,
});
if (process.env.FORGE_GIT_REPO)
  importGitRepository(
    forge,
    process.env.FORGE_GIT_REPO,
    "airtty",
    Number(process.env.FORGE_GIT_COMMITS ?? 8),
  );

/** Simulated Server work, to make progressive Flight streaming visible. */
export const slow = (factor = 1) =>
  Bun.sleep(Math.round(Number(process.env.FORGE_SLOW_MS ?? 250) * factor));

/** The caller resolved by `server/auth.ts`; the framework rejects anonymous calls earlier. */
export function actor(): Actor {
  const session = getSession();
  const { userId, name, role, sessionId } = session;
  if (
    typeof name !== "string" ||
    typeof sessionId !== "string" ||
    (role !== "maintainer" && role !== "contributor" && role !== "reader")
  )
    throw new Error("Invalid session");
  return { id: userId, name, role, sessionId };
}
