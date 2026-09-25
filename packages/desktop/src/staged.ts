/**
 * What `bun run stage` leaves for the build (scripts/stage.ts): the app's two-role binary
 * in `.stage/bin`, described by `.stage/app.json`. The bundle keeps the same layout
 * under `airtty/`, next to the views.
 */
import * as z from "zod/mini";

export const STAGE = ".stage";
/** Where the staged files land in the bundle, relative to `Resources/app`. */
export const BUNDLED = "airtty";

export const stagedApp = z.object({
  /** The binary's file name in `bin/`, and the application's name. */
  name: z.string().check(z.regex(/^[a-z0-9][\w.-]{0,63}$/i)),
});
export type StagedApp = z.infer<typeof stagedApp>;
