import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import type { AppBundle } from "./bundle";
import { signedBytes, type BundleManifest } from "./loader";

export function publisherKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}
export function signBundle(
  bundle: AppBundle,
  keys: { privateKey: KeyObject; publicKey: string },
  overrides: Partial<BundleManifest> = {},
) {
  const manifest: BundleManifest = {
    buildId: bundle.buildId,
    sha256: bundle.sha256,
    size: Buffer.byteLength(bundle.code),
    abi: bundle.abi,
    builtins: bundle.builtins,
    publicKey: keys.publicKey,
    ...overrides,
  };
  return {
    manifest,
    signature: sign(null, signedBytes(manifest), keys.privateKey).toString("base64"),
  };
}

/**
 * What an airtty Server needs to serve a generic Client: two GET routes. They sit in
 * front of the application's real Server here, which forwards everything else to it
 * (render, action and live streams pass through unbuffered).
 */
export function serveBundle(options: {
  upstream: string;
  signed: { manifest: BundleManifest; signature: string };
  code: string;
}) {
  const hits = { manifest: 0, bundle: 0, forwarded: 0 };
  let current = options;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/manifest") {
        hits.manifest++;
        return Response.json(current.signed);
      }
      if (req.method === "GET" && url.pathname === "/bundle") {
        hits.bundle++;
        return new Response(current.code, {
          headers: {
            "content-type": "text/javascript",
            "x-airtty-bundle": current.signed.manifest.sha256,
          },
        });
      }
      hits.forwarded++;
      const headers = new Headers(req.headers);
      headers.delete("host");
      const upstream = await fetch(options.upstream + url.pathname + url.search, {
        method: req.method,
        headers,
        body: req.method === "GET" ? undefined : await req.arrayBuffer(),
        signal: req.signal,
      });
      return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    hits,
    /** Serves other bytes or another manifest from now on: tampering, key rotation. */
    replace(next: Partial<typeof options>) {
      current = { ...current, ...next };
    },
    stop: () => server.stop(true),
  };
}
