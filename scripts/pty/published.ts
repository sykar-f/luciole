/**
 * An application opened by URL (`airtty http://…`), as the generic and sandbox journeys
 * need it: private XDG directories, a small library of documents, mdreader built with a
 * bundle signed by a publisher key, its Server, and the generic Client on a PTY.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { drive } from "./driver";
import { BUN, CLI, airtty, build, example, startServer } from "./harness";

export const MDREADER = example("mdreader");
const OPEN_TIMEOUT_MS = 40_000;
const QUIT_TIMEOUT_MS = 10_000;

/**
 * HOME and every XDG directory under `base`, and two documents whose text says which
 * journey shows them (`alpha-<tag>`, `beta-<tag>`).
 */
export function privateEnvironment(base: string, tag: string) {
  const docs = join(base, "docs");
  mkdirSync(docs);
  writeFileSync(join(docs, "README.md"), `# Handbook\n\nalpha-${tag}\n`);
  writeFileSync(join(docs, "guide.md"), `# Guide\n\nbeta-${tag}\n`);
  const env = {
    HOME: join(base, "home"),
    XDG_CONFIG_HOME: join(base, "config"),
    XDG_STATE_HOME: join(base, "state"),
    XDG_CACHE_HOME: join(base, "cache"),
    XDG_DATA_HOME: join(base, "data"),
  };
  return { env, docs };
}

/** A new publisher key in `config`, and mdreader built with a bundle it signs: its fingerprint. */
export function publish(env: Record<string, string>, config: string) {
  const publisher = { ...env, XDG_CONFIG_HOME: config };
  airtty(["keys", "generate"], { env: publisher, check: true });
  const fingerprint = /SHA256:\S+/.exec(airtty(["keys"], { env: publisher, check: true }).stdout);
  if (!fingerprint) throw new Error("`airtty keys` printed no fingerprint");
  build(MDREADER, ["--sign-bundle"], publisher);
  return fingerprint[0];
}

/** mdreader's Server on `docs`, on `port` (a free one by default). */
export const startLibrary = (env: Record<string, string>, docs: string, port = 0) =>
  startServer(MDREADER, {
    ...env,
    // As a user starts it: the environment's mode, not the production one.
    NODE_ENV: process.env.NODE_ENV,
    PORT: String(port),
    MD_PATH: docs,
  });

/** `airtty <url> …args` on a PTY, from `cwd`. */
export const openByUrl = (
  url: string,
  args: readonly string[],
  env: Record<string, string>,
  cwd: string,
) =>
  drive({
    command: [BUN, CLI, url, ...args],
    cols: 120,
    rows: 30,
    cwd,
    env,
    settle: 200,
    timeout: OPEN_TIMEOUT_MS,
    exitTimeout: QUIT_TIMEOUT_MS,
  });
