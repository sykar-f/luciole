import "server-only";
import { getCallId, getSession, notFound } from "airtty/server";
import { z } from "zod";
import type { Role } from "../components/model";
import { createForge, type Actor } from "./forge";
import { importGitRepository } from "./git-import";
import { openDatabase } from "./schema";

const DEFAULT_GIT_COMMITS = 8,
  DEFAULT_SLOW_MS = 250;
const env = z
  .object({
    FORGE_DB: z.string().default("forge.sqlite"),
    FORGE_CI_SCALE: z.coerce.number().nonnegative().default(1),
    FORGE_GIT_REPO: z.string().optional(),
    FORGE_GIT_COMMITS: z.coerce.number().int().positive().default(DEFAULT_GIT_COMMITS),
    FORGE_SLOW_MS: z.coerce.number().nonnegative().default(DEFAULT_SLOW_MS),
    // Test-only: "now" at startup, as an ISO date. Time still flows (CI runs, sessions
    // expire) but relative ages on screen no longer depend on the day of the run.
    FORGE_CLOCK_START: z.iso.datetime().transform(Date.parse).optional(),
  })
  .parse(process.env);

// The single Forge of this Server process. Pages, Server Functions and the auth
// adapter share it; tests and the operator script build their own from `createForge`.
const start = env.FORGE_CLOCK_START,
  booted = Date.now();
export const forge = createForge(openDatabase(env.FORGE_DB), {
  ciScale: env.FORGE_CI_SCALE,
  callId: getCallId,
  now: start === undefined ? undefined : () => start + (Date.now() - booted),
});
if (env.FORGE_GIT_REPO)
  importGitRepository(forge, env.FORGE_GIT_REPO, "airtty", env.FORGE_GIT_COMMITS);

/** Simulated Server work, to make progressive Flight streaming visible. */
export const slow = (factor = 1) => Bun.sleep(Math.round(env.FORGE_SLOW_MS * factor));

// What `server/auth.ts` puts in the session beyond the framework's `userId`.
const ActorSession = z.object({
  userId: z.string(),
  name: z.string(),
  role: z.enum(["maintainer", "contributor", "reader"]) satisfies z.ZodType<Role>,
  sessionId: z.string(),
});
/** The caller resolved by `server/auth.ts`; the framework rejects anonymous calls earlier. */
export function actor(): Actor {
  const session = ActorSession.safeParse(getSession());
  if (!session.success) throw new Error("Invalid session");
  const { userId, name, role, sessionId } = session.data;
  return { id: userId, name, role, sessionId };
}

// URL parameters are strings the Server already checked are present; a number is parsed.
const PullNumber = z.coerce.number().int().positive();
/** The pull request a `[repo]/pulls/[number]` URL names, or the page's not-found screen. */
export function pullAt(params: { repo: string; number: string }) {
  const number = PullNumber.safeParse(params.number);
  const pull = number.success ? forge.pull(params.repo, number.data) : null;
  if (!pull) notFound(`Pull request ${params.repo}#${params.number}`);
  return pull;
}
