/**
 * What a Server serves of its application bundle (docs/EMBEDDING.md, step 4), for hosts
 * that load the application without having it: `GET /manifest` (the signed manifest, as
 * the build wrote it) and `GET /bundle/<sha256>` (its bytes). Public like the manifest a
 * browser fetches: no session, no build header (they are how a Client learns the build).
 *
 * The bundle is addressed by its hash: a URL names one content forever, so it may be
 * cached as immutable. Read once at startup, and only when the build produced a bundle
 * (none for Client code with top-level await, none inside a compiled binary).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_MANIFEST, AppManifest } from "./abi";

const IMMUTABLE = "public, max-age=31536000, immutable";
const NOT_FOUND = 404;
const BUNDLE_PATH = /^\/bundle\/([0-9a-f]{64})$/;

const isBundleRoute = (url: URL) => url.pathname === "/manifest" || BUNDLE_PATH.test(url.pathname);
/**
 * The handler of both routes (`undefined`: not one of them). Without a bundle they
 * answer 404, never the build check's 409: this Server has nothing to embed.
 */
export function appRoutes(directory: string | undefined) {
  if (!directory || !existsSync(join(directory, APP_MANIFEST)))
    return (req: Request, url: URL): Response | undefined =>
      req.method === "GET" && isBundleRoute(url)
        ? new Response("This Server has no application bundle", { status: NOT_FOUND })
        : undefined;
  const text = readFileSync(join(directory, APP_MANIFEST), "utf8");
  const manifest = AppManifest.parse(JSON.parse(text));
  const bytes = readFileSync(join(directory, manifest.bundle));
  // A bundle that no longer matches its manifest is a broken deployment: say so now.
  if (createHash("sha256").update(bytes).digest("hex") !== manifest.sha256)
    throw new Error(`${join(directory, manifest.bundle)} does not match its manifest (sha256)`);
  return (req: Request, url: URL): Response | undefined => {
    if (req.method !== "GET") return undefined;
    if (url.pathname === "/manifest")
      return new Response(text, {
        headers: { "content-type": "application/json", "cache-control": "no-cache" },
      });
    const hash = BUNDLE_PATH.exec(url.pathname)?.[1];
    if (hash === undefined) return undefined;
    if (hash !== manifest.sha256) return new Response("Unknown bundle", { status: NOT_FOUND });
    return new Response(bytes, {
      headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": IMMUTABLE },
    });
  };
}
