import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as z from "zod/mini";
import type { Session } from "./restore";

// Every change is written this long after the last one: typing writes once per pause.
export const SAVE_DELAY_MS = 200;
const DAY_MS = 86_400_000;
// A session left by a Client that died is offered this long, then deleted.
export const ORPHAN_RETENTION_DAYS = 7;
export const ORPHAN_RETENTION_MS = ORPHAN_RETENTION_DAYS * DAY_MS;
const PRIVATE_FILE = 0o600,
  PRIVATE_DIRECTORY = 0o700;

/** A session file, as `openSession` writes it. Read back from disk: validated. */
const SessionFile = z.object({
  version: z.literal(1),
  /** The Server address the user configured (not a tunnel's local port). */
  server: z.string(),
  pid: z.number().check(z.int()),
  updatedAt: z.number(),
  index: z.number().check(z.int(), z.gte(0)),
  entries: z.array(z.object({ href: z.string(), fields: z.record(z.string(), z.string()) })),
});
type SessionFile = z.infer<typeof SessionFile>;
/** Supervisor-given session ids name a file: nothing that could leave the directory. */
export const SessionId = z.string().check(z.regex(/^[\w-]{1,64}$/));

/** `$XDG_STATE_HOME/airtty/<app>/sessions` (`~/.local/state/airtty/<app>/sessions`). */
export const sessionDirectory = (name: string, env: NodeJS.ProcessEnv = process.env) =>
  join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "airtty", name, "sessions");

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    // Another user's process: alive, and not ours to take.
    return typeof e === "object" && e !== null && "code" in e && e.code === "EPERM";
  }
}
function read(file: string): SessionFile | undefined {
  try {
    const parsed = SessionFile.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export type SessionStore = {
  /** What this Client restores: its own session, or the one a crashed Client left. */
  restored: Session | undefined;
  /** Writes `session` after `SAVE_DELAY_MS` without a newer change. */
  schedule(session: Session): void;
  /** Writes `session` now: before the process ends on a signal. */
  flush(session: Session): void;
  /** Deletes the session: the user quit on purpose, nothing is offered next time. */
  remove(): void;
};
const nothing: SessionStore = {
  restored: undefined,
  schedule: () => {},
  flush: () => {},
  remove: () => {},
};

/**
 * One file per Client, like one browser tab: two Clients never share one. A Client
 * started with `id` (the development supervisor, across rebuilds) reopens that file.
 * Otherwise it takes over the newest session a dead Client left for the same Server,
 * as a browser offers to restore after a crash. Files are private to the user (0600).
 * A failing disk never stops the Client: it then keeps nothing.
 */
export function openSession(options: {
  name: string;
  server: string;
  id?: string;
  env?: NodeJS.ProcessEnv;
}): SessionStore {
  const { name, server, id } = options;
  let directory: string;
  try {
    directory = sessionDirectory(name, options.env);
    mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY });
  } catch {
    return nothing;
  }
  const path = join(directory, `${id ?? crypto.randomUUID()}.json`);
  const left: { file: string; data: SessionFile }[] = [];
  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith(".json")) continue;
    const file = join(directory, entry);
    const data = read(file);
    if (!data || file === path || alive(data.pid)) continue;
    if (Date.now() - data.updatedAt > ORPHAN_RETENTION_MS) {
      try {
        unlinkSync(file);
      } catch {}
      continue;
    }
    if (data.server === server) left.push({ file, data });
  }
  const write = (session: Session) => {
    const file: SessionFile = {
      version: 1,
      server,
      pid: process.pid,
      updatedAt: Date.now(),
      index: session.index,
      entries: session.entries,
    };
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(file), { mode: PRIVATE_FILE });
      renameSync(temporary, path);
    } catch {}
  };
  let restored = id ? read(path) : undefined;
  if (!id)
    for (const candidate of left.sort((a, b) => b.data.updatedAt - a.data.updatedAt)) {
      try {
        // Atomic: of two Clients starting together, one takes it, the other fails here.
        renameSync(candidate.file, path);
        restored = candidate.data;
        // Still marked with the dead pid: claim it before another Client sees it.
        write(restored);
        break;
      } catch {}
    }
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    restored: restored ? { index: restored.index, entries: restored.entries } : undefined,
    schedule(session) {
      clearTimeout(timer);
      timer = setTimeout(() => write(session), SAVE_DELAY_MS);
      timer.unref();
    },
    flush(session) {
      clearTimeout(timer);
      write(session);
    },
    remove() {
      clearTimeout(timer);
      try {
        unlinkSync(path);
      } catch {}
    },
  };
}
