import "server-only";
import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { listInstalled } from "../../../registry/apps";
import { npmRegistry } from "../../../registry/npm";
import { directories } from "../../paths";

/**
 * What `luciole` (src/launcher/home.ts) hands its launcher: where to write the target
 * the user picked, and what happened to the previous one.
 */
const Environment = z.object({
  LUCIOLE_LAUNCHER_HANDOFF: z.string().min(1),
  LUCIOLE_LAUNCHER_NOTICE: z.string().optional(),
});
const env = Environment.parse(process.env);

export const paths = directories();
export const registry = npmRegistry();
export const notice = env.LUCIOLE_LAUNCHER_NOTICE || undefined;

export const installedApps = async () =>
  (await listInstalled(paths)).map((app) => ({
    app: app.app,
    package: app.package,
    version: app.version,
    range: app.range,
  }));

/** Hands `target` to `luciole`, which launches it once this launcher has quit. */
export const handOff = (target: string) => writeFile(env.LUCIOLE_LAUNCHER_HANDOFF, target);
