/**
 * What the generic Client does with a Server URL before anything of it runs
 * (docs/EMBEDDING.md, steps 5 and 7), in the launcher's process, which still has the
 * terminal for its questions: read `/manifest`, verify the publisher's signature, pin the
 * key per origin on first use (a changed key is refused), settle the mode and what is
 * granted, then fetch `/bundle/<sha256>` into the cache unless it is there already.
 *
 * The mode: `sandbox` by default where it exists (macOS, step 7), the application's
 * capabilities shown with who enforces each, and accepted once per origin. `inline` only
 * when the user chooses it (`--inline`, remembered). Elsewhere (Linux until step 8), an
 * origin opens only inline, by explicit choice: nothing is opened by default.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { ABI_KEY, APP_MANIFEST, AppManifest } from "../abi";
import { connect } from "../connect";
import { Capabilities, granted as declaredNames } from "../capabilities";
import type { Confirm } from "../launcher/prompt";
import type { Directories } from "../launcher/paths";
import { verifyManifest } from "../publisher";
import {
  beyond,
  enforcement,
  ENFORCERS,
  mergeCapabilities,
  unenforceable,
} from "../sandbox/grants";
import { stillDenied } from "../sandbox/permissions";
import { sandboxSupported } from "../sandbox/runtime";
import { originDirectory, originOf, originSessions, readOrigin, writeOrigin } from "./origin";

/** Shown before an inline application opens (docs/EMBEDDING.md, decision 5). */
export const INLINE_WARNING =
  "Confiance totale : cette app s'exécute dans le processus du lanceur ; aucune capacité n'est appliquée.";
/** Shown before a sandboxed application opens, above what it is granted. */
export const SANDBOX_HEADER =
  "Sandbox (Seatbelt) : l'app ne lit, n'écrit, n'exécute et ne joint que ce qui suit, chaque ligne dit qui l'applique.";
const NOT_FOUND = 404;
const NOTHING = Capabilities.parse({});

export type Mode = "inline" | "sandbox";
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
  mode: Mode;
  /** Mediated capabilities the user refused at run time (src/sandbox/permissions.ts). */
  denied: string[];
  /** What the sandbox enforces; nothing is enforced inline. */
  granted: Capabilities;
};
export type PrepareOptions = {
  /** The mode the user asked for (`--inline`, `--sandbox`); otherwise remembered or default. */
  mode?: Mode;
  /** `--allow-*` flags: granted on top of what the origin has, and remembered. */
  allow?: Capabilities;
  /** Whether this system runs the sandbox mode; by default, macOS with Seatbelt. */
  sandbox?: boolean;
  directories: Pick<Directories, "bundles">;
  confirm: Confirm;
  log: (message: string) => void;
  env?: NodeJS.ProcessEnv;
};

/** Who lets the child reach its Server: the only network it has without `net`. */
function serverLine(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol === "ssh:") return `OS (Seatbelt, le socket du tunnel ssh de l'hôte)`;
  if (["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname))
    return `OS (Seatbelt, localhost:${parsed.port || "80"} seulement)`;
  return "proxy (l'OS limite l'app au port du proxy de l'hôte)";
}
/** The capabilities screen: every grant with who applies it, never one that nobody does. */
export function describeSandbox(url: string, caps: Capabilities, refused: readonly string[]) {
  const lines = enforcement(caps).map(
    (line) => `  ${line.capability} — ${ENFORCERS[line.by]} (${line.how})`,
  );
  return [
    SANDBOX_HEADER,
    `  Server de l'app ${url} — ${serverLine(url)}`,
    ...(lines.length ? lines : ["  Capacités accordées : aucune"]),
    ...refused.map((why) => `  refusée : ${why}`),
  ].join("\n");
}

export async function prepareOrigin(url: string, options: PrepareOptions): Promise<PreparedOrigin> {
  const env = options.env ?? process.env;
  const origin = originOf(url);
  const sandbox = options.sandbox ?? sandboxSupported();
  const allow = options.allow ?? NOTHING;
  const flagged = declaredNames(allow);
  // Decided before the Server is even contacted: nothing of an origin the user has not
  // chosen to open is fetched.
  const record = readOrigin(origin, env);
  const mode = options.mode ?? record?.mode ?? (sandbox ? "sandbox" : undefined);
  if (!mode)
    throw new Error(
      `${origin}: an application opened by URL would run with your rights, and the ` +
        `sandbox mode does not exist on ${process.platform} yet (docs/EMBEDDING.md, step 8). ` +
        `If you trust it fully, open it inline: airtty ${url} --inline`,
    );
  if (mode === "sandbox" && !sandbox)
    throw new Error(
      `${origin}: the sandbox mode does not exist on ${process.platform} yet (docs/EMBEDDING.md, step 8)`,
    );
  if (mode === "inline" && flagged.length)
    throw new Error(
      `${flagged.join(", ")}: --allow-* flags grant sandbox capabilities, and inline enforces none`,
    );
  if (allow.pty) throw new Error(`--allow-pty: ${unenforceable(allow)}`);
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
    const declared = manifest.capabilities ?? NOTHING;
    const heading = `${manifest.name} · ${origin} · publisher ${fingerprint}`;
    const firstUse = !pinned;
    const modeChanged = record?.mode !== mode;
    // Asked once per origin, and again when the user changes its mode.
    const accept = async (question: string) => {
      if (!(await options.confirm(question))) throw new Error(`${origin}: not opened`);
    };
    let granted = NOTHING;
    if (mode === "inline") {
      const names = declaredNames(declared);
      options.log(
        `${heading}\n${INLINE_WARNING}\n` +
          `Capacités déclarées (non appliquées) : ${names.length ? names.join(", ") : "aucune"}`,
      );
      if (firstUse)
        await accept(
          `First use of ${origin}: trust publisher key ${fingerprint} and open it inline?`,
        );
      else if (modeChanged) await accept(`Open ${origin} inline from now on?`);
    } else {
      const kept = mergeCapabilities(modeChanged ? NOTHING : (record?.granted ?? NOTHING), allow);
      // What the application declares beyond what it has, offered once. Never pty: it
      // cannot be confined on macOS, it is shown as refused.
      const wanted = beyond({ ...declared, pty: false }, kept);
      const refused = declared.pty ? [`pty — ${unenforceable({ ...NOTHING, pty: true })}`] : [];
      const offered = wanted ? mergeCapabilities(kept, wanted) : kept;
      const impossible = unenforceable(offered);
      if (impossible) throw new Error(`${origin}: not opened in the sandbox, ${impossible}`);
      options.log(`${heading}\n${describeSandbox(url, offered, refused)}`);
      granted = offered;
      if (firstUse)
        await accept(
          `First use of ${origin}: trust publisher key ${fingerprint} and open it in the sandbox with these capabilities?`,
        );
      else if (modeChanged)
        await accept(`Open ${origin} in the sandbox with these capabilities from now on?`);
      else if (
        wanted &&
        !(await options.confirm(
          `${origin} now also asks for ${declaredNames(wanted).join(", ")}: grant it?`,
        ))
      ) {
        // Declined: it opens with what it had, and is asked again next time.
        granted = kept;
        options.log(`Refusé : ${declaredNames(wanted).join(", ")}`);
      }
    }
    // Refused when the application asked at run time, unless granted since.
    const denied =
      mode === "sandbox" && !modeChanged ? stillDenied(granted, record?.denied ?? []) : [];
    const changed =
      firstUse ||
      modeChanged ||
      JSON.stringify(granted) !== JSON.stringify(record?.granted ?? NOTHING) ||
      denied.length !== (record?.denied ?? []).length;
    if (changed) {
      const now = new Date().toISOString();
      writeOrigin(
        {
          origin,
          publisher: record?.publisher ?? { fingerprint, pinnedAt: now },
          mode,
          capabilities: manifest.capabilities,
          ...(mode === "sandbox" && { granted, denied }),
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
    return {
      url,
      origin,
      name: manifest.name,
      app,
      fingerprint,
      sessions: originSessions(origin),
      mode,
      granted,
      denied,
    };
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
