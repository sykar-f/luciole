/**
 * What the generic Client does with a Server URL before anything of it runs
 * (docs/EMBEDDING.md, step 5), in the launcher's process, which still has the terminal
 * for its questions: read `/manifest`, verify the publisher's signature, pin the key per
 * origin on first use (a changed key is refused), settle the mode, then fetch
 * `/bundle/<sha256>` into the cache unless it is there already.
 *
 * The mode: the sandbox (steps 7 and 8) does not exist yet, and the other two modes give
 * the application the user's rights. So an origin opens only once the user chose
 * `inline` for it explicitly (`--inline`, remembered); nothing is opened by default.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { ABI_KEY, APP_MANIFEST, AppManifest } from "../abi";
import { connect } from "../connect";
import { granted } from "../capabilities";
import type { Confirm } from "../launcher/prompt";
import type { Directories } from "../launcher/paths";
import { verifyManifest } from "../publisher";
import { originDirectory, originOf, originSessions, readOrigin, writeOrigin } from "./origin";

/** Shown before an inline application opens (docs/EMBEDDING.md, decision 5). */
export const INLINE_WARNING =
  "Confiance totale : cette app s'exécute dans le processus du lanceur ; aucune capacité n'est appliquée.";
const NOT_FOUND = 404;

/** What the host needs to open one origin in a tab. */
export type PreparedOrigin = {
  url: string;
  origin: string;
  name: string;
  /** `<origin>/app`: the manifest as received and the cached bundle. */
  app: string;
  /** The pinned key: the host refuses a bundle signed by another. */
  fingerprint: string;
  /** `openSession` name of the origin's own sessions. */
  sessions: string;
};
export type PrepareOptions = {
  inline: boolean;
  directories: Pick<Directories, "bundles">;
  confirm: Confirm;
  log: (message: string) => void;
  env?: NodeJS.ProcessEnv;
};

export async function prepareOrigin(url: string, options: PrepareOptions): Promise<PreparedOrigin> {
  const env = options.env ?? process.env;
  const origin = originOf(url);
  // Decided before the Server is even contacted: nothing of an origin the user has not
  // chosen to trust is fetched.
  const record = readOrigin(origin, env);
  const mode = record?.mode ?? (options.inline ? "inline" : undefined);
  if (!mode)
    throw new Error(
      `${origin}: an application opened by URL would run with your rights, and the ` +
        "sandbox mode does not exist yet (docs/EMBEDDING.md, steps 7-8). If you trust it " +
        `fully, open it inline: airtty ${url} --inline`,
    );
  // The Server's own address, through a tunnel for ssh://; the origin stays the URL given.
  const connection = await connect(url, undefined, env);
  try {
    const get = (path: string) =>
      (connection.fetch ?? fetch)(new URL(path, connection.url), { method: "GET" });
    const answer = await get("/manifest");
    if (answer.status === NOT_FOUND)
      throw new Error(
        `${origin} serves no application bundle: its app cannot be opened by URL ` +
          "(the publisher builds it with airtty build --sign-bundle)",
      );
    if (!answer.ok) throw new Error(`${origin}/manifest answered ${answer.status}`);
    const text = await answer.text();
    const manifest = AppManifest.parse(JSON.parse(text));
    const fingerprint = verifyManifest(manifest);
    if (!fingerprint)
      throw new Error(`${origin}: its bundle is not signed by its publisher, it is not opened`);
    if (manifest.abi !== ABI_KEY)
      throw new Error(
        `${origin}: its bundle was built for runtime ABI ${manifest.abi}, this Client runs ${ABI_KEY}`,
      );
    const pinned = record?.publisher?.fingerprint;
    if (pinned && pinned !== fingerprint)
      throw new Error(
        `${origin}: its publisher key changed, the app is not opened.\n` +
          `  pinned  ${pinned}\n  now     ${fingerprint}\n` +
          "If the publisher confirms the change (out of band, not through this Server), pin the new key:\n" +
          `  airtty trust ${origin} ${fingerprint}`,
      );
    const declared = manifest.capabilities ? granted(manifest.capabilities) : [];
    options.log(
      `${manifest.name} · ${origin} · publisher ${fingerprint}\n${INLINE_WARNING}\n` +
        `Capacités déclarées (non appliquées) : ${declared.length ? declared.join(", ") : "aucune"}`,
    );
    // Asked once per origin, and again when the user changes its mode.
    if (!pinned || !record?.mode) {
      const accepted = await options.confirm(
        pinned
          ? `Open ${origin} inline from now on?`
          : `First use of ${origin}: trust publisher key ${fingerprint} and open it inline?`,
      );
      if (!accepted) throw new Error(`${origin}: not opened`);
      const now = new Date().toISOString();
      writeOrigin(
        {
          origin,
          publisher: record?.publisher ?? { fingerprint, pinnedAt: now },
          mode,
          capabilities: manifest.capabilities,
          acceptedAt: now,
        },
        env,
      );
    }
    const cached = await cacheBundle(manifest, options.directories.bundles, (path) => get(path));
    // The origin's app: its manifest as received, next to a link to the shared cache.
    const app = join(originDirectory(origin, env), "app");
    mkdirSync(app, { recursive: true, mode: 0o700 });
    const temporary = join(app, `${APP_MANIFEST}.${process.pid}`);
    await Bun.write(temporary, text);
    renameSync(temporary, join(app, APP_MANIFEST));
    rmSync(join(app, manifest.bundle), { force: true });
    symlinkSync(cached, join(app, manifest.bundle));
    return { url, origin, name: manifest.name, app, fingerprint, sessions: originSessions(origin) };
  } finally {
    connection.close();
  }
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** `<bundles>/<sha256>.cjs`, downloaded when absent or damaged; bytes checked by hash. */
async function cacheBundle(
  manifest: AppManifest,
  directory: string,
  get: (path: string) => Promise<Response>,
) {
  const file = join(directory, `${manifest.sha256}.cjs`);
  if (existsSync(file) && sha256(readFileSync(file)) === manifest.sha256) return file;
  const answer = await get(`/bundle/${manifest.sha256}`);
  if (!answer.ok) throw new Error(`/bundle/${manifest.sha256} answered ${answer.status}`);
  const bytes = new Uint8Array(await answer.arrayBuffer());
  if (sha256(bytes) !== manifest.sha256)
    throw new Error("The downloaded bundle does not match its signed manifest (sha256)");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}`;
  await Bun.write(temporary, bytes);
  renameSync(temporary, file);
  return file;
}
