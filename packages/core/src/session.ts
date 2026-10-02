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
  entries: z.array(
    z.object({
      href: z.string(),
      fields: z.record(z.string(), z.string()),
      focus: z.optional(z.string()),
      scroll: z.optional(z.record(z.string(), z.number().check(z.int(), z.gte(0)))),
    }),
  ),
});
type SessionFile = z.infer<typeof SessionFile>;
/** Supervisor-given session ids name a file: nothing that could leave the directory. */
export const SessionId = z.string().check(z.regex(/^[\w-]{1,64}$/));

/** `$XDG_STATE_HOME/luciole/<app>/sessions` (`~/.local/state/luciole/<app>/sessions`). */
export const sessionDirectory = (name: string, env: NodeJS.ProcessEnv = process.env) =>
  join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "luciole", name, "sessions");

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

type Orphan = { file: string; data: SessionFile };
/** Session files left by dead Clients: expired ones are deleted on the way. */
function orphans(directory: string, except?: string) {
  const left: Orphan[] = [];
  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith(".json")) continue;
    const file = join(directory, entry);
    const data = read(file);
    if (!data || file === except || alive(data.pid)) continue;
    if (Date.now() - data.updatedAt > ORPHAN_RETENTION_MS) {
      try {
        unlinkSync(file);
      } catch {}
      continue;
    }
    left.push({ file, data });
  }
  return left;
}
/**
 * Takes the newest of `candidates` to `path`, marked with this process at once: of two
 * processes claiming together, one renames it, the other fails and tries the next.
 */
function claim(candidates: readonly Orphan[], path: string, write: (session: SessionFile) => void) {
  for (const candidate of [...candidates].sort((a, b) => b.data.updatedAt - a.data.updatedAt)) {
    try {
      renameSync(candidate.file, path);
      // Still marked with the dead pid: claimed before another process sees it.
      write(candidate.data);
      return candidate.data;
    } catch {}
  }
  return undefined;
}

/**
 * For a launcher reattaching a crashed Client's launch (src/launcher/launch-key.ts): claims
 * the newest session a dead Client left whose Server key `accept`s, under a new id, marked
 * with this process until the Client it starts opens it (`LUCIOLE_SESSION`). Resolves with
 * that id and the key, or `undefined`: nothing to reattach, or no disk.
 */
export async function claimOrphan(options: {
  name: string;
  accept: (server: string) => boolean | Promise<boolean>;
  env?: NodeJS.ProcessEnv;
}) {
  let directory: string;
  try {
    directory = sessionDirectory(options.name, options.env);
    mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY });
  } catch {
    return undefined;
  }
  const accepted: Orphan[] = [];
  for (const orphan of orphans(directory))
    if (await options.accept(orphan.data.server)) accepted.push(orphan);
  const id = crypto.randomUUID();
  const path = join(directory, `${id}.json`);
  const claimed = claim(accepted, path, (data) => {
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(
        temporary,
        JSON.stringify({ ...data, pid: process.pid, updatedAt: Date.now() }),
        {
          mode: PRIVATE_FILE,
        },
      );
      renameSync(temporary, path);
    } catch {}
  });
  return claimed ? { id, server: claimed.server } : undefined;
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
  const left = orphans(directory, path).filter((orphan) => orphan.data.server === server);
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
  if (!id) restored = claim(left, path, write);
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
