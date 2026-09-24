/**
 * An origin (docs/EMBEDDING.md, section 1): what receives trust when an application is
 * opened by URL. It is the URL the user gave, normalized (scheme, host, port; the path
 * too for ssh, which names the remote socket), never the address a tunnel ends up on.
 *
 * Everything the generic Client keeps about an origin lives under
 * `$XDG_STATE_HOME/airtty/origins/<sha256(origin)>/`, private to the user: `origin.json`
 * (the publisher key pinned on first use, the mode the user chose, the capabilities the
 * application declared when the user accepted it), `app/` (its current manifest and a
 * link to the cached bundle) and `sessions/` (its history and named fields). Another
 * origin never reads it.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod/mini";
import { Capabilities } from "../capabilities";
import { directories } from "../launcher/paths";

const PRIVATE_FILE = 0o600;
const PRIVATE_DIRECTORY = 0o700;

/** The origin of a Server URL, as trust and storage key it. */
export function originOf(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.origin;
  if (parsed.protocol === "ssh:") {
    const user = parsed.username ? `${parsed.username}@` : "";
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `ssh://${user}${parsed.host.toLowerCase()}${path}`;
  }
  throw new Error(`${url}: an origin is an http(s):// or ssh:// URL`);
}
/** `sha256(origin)`, hex: the origin's directory name, whatever characters it holds. */
export const originKey = (origin: string) => createHash("sha256").update(origin).digest("hex");
export const originDirectory = (origin: string, env: NodeJS.ProcessEnv = process.env) =>
  join(directories(env).state, "origins", originKey(origin));
/** The `openSession` name whose directory is the origin's `sessions/`. */
export const originSessions = (origin: string) => `origins/${originKey(origin)}`;

export const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
export const OriginRecord = z.object({
  origin: z.string(),
  /** The publisher key pinned on first use, or with `airtty trust`. */
  publisher: z.optional(
    z.object({ fingerprint: z.string().check(z.regex(FINGERPRINT)), pinnedAt: z.string() }),
  ),
  /** What the user chose explicitly; `inline` only until the sandbox exists. */
  mode: z.optional(z.literal("inline")),
  /** What the application declared when the user accepted it. */
  capabilities: z.optional(Capabilities),
  acceptedAt: z.optional(z.string()),
});
export type OriginRecord = z.infer<typeof OriginRecord>;

export function readOrigin(origin: string, env: NodeJS.ProcessEnv = process.env) {
  let text: string;
  try {
    text = readFileSync(join(originDirectory(origin, env), "origin.json"), "utf8");
  } catch {
    return undefined;
  }
  const parsed = OriginRecord.safeParse(JSON.parse(text));
  if (!parsed.success || parsed.data.origin !== origin)
    throw new Error(`${origin}: its stored record is damaged (${originDirectory(origin, env)})`);
  return parsed.data;
}
export function writeOrigin(record: OriginRecord, env: NodeJS.ProcessEnv = process.env) {
  const directory = originDirectory(record.origin, env);
  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY });
  const file = join(directory, "origin.json");
  const temporary = `${file}.${process.pid}`;
  writeFileSync(temporary, JSON.stringify(record, null, 2), { mode: PRIVATE_FILE });
  renameSync(temporary, file);
}
/** Pins `fingerprint` for `origin`, replacing any key: `airtty trust`, out of band. */
export function pinPublisher(
  origin: string,
  fingerprint: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!FINGERPRINT.test(fingerprint))
    throw new Error(`${fingerprint}: expected a key fingerprint, SHA256:… (as airtty keys shows)`);
  const record = readOrigin(origin, env) ?? { origin };
  writeOrigin({ ...record, publisher: { fingerprint, pinnedAt: new Date().toISOString() } }, env);
}
