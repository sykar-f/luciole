import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { HARNESSES, type HarnessId } from "@luciole-sh/harness/model";

// Which harness session each launch drives, so that a restarted Server (a rebuild in
// development) continues it: `$XDG_STATE_HOME/luciole/coder/launches/<launch id>.json`.
// Session ids only: nothing a harness keeps secret.
const directory = () =>
  join(
    process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
    "luciole",
    "coder",
    "launches",
  );
const LaunchFile = z.object({ harness: z.enum(HARNESSES), sessionId: z.string().min(1) });
const PRIVATE_FILE = 0o600;
const PRIVATE_DIRECTORY = 0o700;
// Launch ids are UUIDs (src/launcher/launch-key.ts): nothing else names a file here.
const SAFE_ID = /^[\w-]{1,64}$/;

export async function rememberedSession(launch: string | undefined, harness: HarnessId) {
  if (!launch || !SAFE_ID.test(launch)) return undefined;
  try {
    const parsed = LaunchFile.safeParse(
      JSON.parse(await readFile(join(directory(), `${launch}.json`), "utf8")),
    );
    return parsed.success && parsed.data.harness === harness ? parsed.data.sessionId : undefined;
  } catch {
    return undefined;
  }
}

export async function rememberLaunch(
  launch: string | undefined,
  harness: HarnessId,
  sessionId: string,
) {
  if (!launch || !SAFE_ID.test(launch)) return;
  try {
    await mkdir(directory(), { recursive: true, mode: PRIVATE_DIRECTORY });
    const file = join(directory(), `${launch}.json`);
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ harness, sessionId }), { mode: PRIVATE_FILE });
    await rename(temporary, file);
  } catch {}
}
