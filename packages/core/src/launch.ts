/**
 * What a Server knows of its launch (`getLaunch()`, @luciole-sh/core/server): which launches share
 * it, its id when each has its own, the directory the command ran in. The launcher side
 * (keys, reattaching a crashed launch) is src/launcher/launch-key.ts; this module reads
 * no disk, so the browser's Server can hold it too.
 */
import * as z from "zod/mini";

/** Which launches share a Server, as an application's package.json says (`luciole.server`). */
export const SERVER_SCOPES = ["shared", "per-directory", "per-launch"] as const;
export const ServerScope = z.enum(SERVER_SCOPES);
export type ServerScope = z.infer<typeof ServerScope>;

export const Launch = z.object({
  v: z.literal(1),
  scope: ServerScope,
  /** The launch's id: per-launch only. */
  id: z.optional(z.string()),
  /** Where the command was typed; the Server runs there. */
  cwd: z.string(),
});
export type Launch = z.infer<typeof Launch>;
export const LAUNCH_VARIABLE = "LUCIOLE_LAUNCH";

/** This Server's launch, from its environment; a Server started by hand is shared. */
export function launchOf(env: Record<string, string | undefined>, cwd: string): Launch {
  const text = env[LAUNCH_VARIABLE];
  if (text === undefined) return { v: 1, scope: "shared", cwd };
  try {
    const parsed = Launch.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
  } catch {}
  throw new Error(`${LAUNCH_VARIABLE} is not a launch description`);
}
