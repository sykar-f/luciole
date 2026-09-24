import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdir, readFile, rename } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { join } from "node:path";
import { runInThisContext } from "node:vm";
import type { AnyRoute } from "@tanstack/react-router";
import { z } from "zod";
import { isAbiSpecifier, type AbiSpecifier } from "./abi";

/** What the generic Client learns from `GET /manifest`, before any code is downloaded. */
export const BundleManifest = z.object({
  buildId: z.string().regex(/^[0-9a-f]+$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().positive(),
  abi: z.string(),
  /** Node built-ins the bundle requires: shown to the user, checked again at load. */
  builtins: z.array(z.string()),
  /** The publisher's Ed25519 key (SPKI, base64). Pinned on first use, like known_hosts. */
  publicKey: z.string(),
});
export type BundleManifest = z.infer<typeof BundleManifest>;
export const SignedManifest = z.object({ manifest: BundleManifest, signature: z.string() });
/** The signed bytes: key order fixed by the schema, never by the sender's JSON. */
export const signedBytes = (m: BundleManifest) =>
  new TextEncoder().encode(
    JSON.stringify([m.buildId, m.sha256, m.size, m.abi, m.builtins, m.publicKey]),
  );
export const fingerprintOf = (publicKey: string) =>
  createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex");

const KnownOrigins = z.record(
  z.string(),
  z.object({ fingerprint: z.string(), pinnedAt: z.string() }),
);
export class TrustError extends Error {}
const MS_PRECISION = 1000;
const FINGERPRINT_SHOWN = 16;

export type LoadedBundle = {
  buildId: string;
  routeTree: AnyRoute;
  modules: Map<string, Record<string, unknown>>;
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isRoute = (value: unknown): value is AnyRoute =>
  isRecord(value) && typeof value.addChildren === "function";

/**
 * Evaluates a `bun-cjs` bundle with `require` limited to the ABI (`abi`) and to the Node
 * built-ins the manifest declared. Each call is a fresh module instance: two origins,
 * or two tabs of one origin, never share module state.
 */
export function evaluateBundle(
  code: string,
  {
    filename,
    abi,
    builtins,
  }: { filename: string; abi: (s: AbiSpecifier) => unknown; builtins: readonly string[] },
): LoadedBundle {
  const required = (specifier: string): unknown => {
    if (isAbiSpecifier(specifier)) return abi(specifier);
    if (isBuiltin(specifier) && builtins.includes(specifier)) return require(specifier);
    throw new TrustError(`${filename} requires ${specifier}, outside the runtime ABI`);
  };
  const wrapper: unknown = runInThisContext(code, { filename });
  if (typeof wrapper !== "function") throw new TrustError(`${filename} is not a bun-cjs bundle`);
  const module = { exports: {} };
  Reflect.apply(wrapper, undefined, [module.exports, required, module, filename, "/"]);
  const exported: unknown = module.exports;
  if (
    !isRecord(exported) ||
    typeof exported.buildId !== "string" ||
    !isRoute(exported.routeTree) ||
    !isRecord(exported.modules)
  )
    throw new TrustError(`${filename} does not export buildId, routeTree and modules`);
  const modules = new Map<string, Record<string, unknown>>();
  for (const [id, value] of Object.entries(exported.modules))
    if (isRecord(value)) modules.set(id, value);
  return { buildId: exported.buildId, routeTree: exported.routeTree, modules };
}

/**
 * The generic Client's download path: manifest, signature, pinned key, ABI, then the
 * bundle from the cache (by hash) or the Server. Every refusal happens before evaluation.
 */
export async function fetchBundle(
  url: string,
  {
    store,
    abiKey,
    fetch = globalThis.fetch,
  }: { store: string; abiKey: string; fetch?: typeof globalThis.fetch },
) {
  const timings: Record<string, number> = {};
  let mark = performance.now();
  const lap = (name: string) => {
    const t = performance.now();
    timings[name] = Math.round((t - mark) * MS_PRECISION) / MS_PRECISION;
    mark = t;
  };
  const origin = new URL(url).origin;
  const signed = SignedManifest.parse(await (await fetch(`${url}/manifest`)).json());
  lap("manifest");
  const { manifest } = signed;
  const key = createPublicKey({
    key: Buffer.from(manifest.publicKey, "base64"),
    format: "der",
    type: "spki",
  });
  if (!verify(null, signedBytes(manifest), key, Buffer.from(signed.signature, "base64")))
    throw new TrustError(`${origin}: manifest signature does not verify`);
  // Trust on first use, per origin: a later key change is refused, as ssh refuses a
  // changed host key. Rotation needs a statement signed by the pinned key (not probed).
  const knownFile = join(store, "known-origins.json");
  const known = KnownOrigins.parse(
    await readFile(knownFile, "utf8").then(
      (t): unknown => JSON.parse(t),
      () => ({}),
    ),
  );
  const fingerprint = fingerprintOf(manifest.publicKey);
  const pinned = known[origin];
  if (pinned && pinned.fingerprint !== fingerprint)
    throw new TrustError(
      `${origin}: publisher key changed (pinned ${pinned.fingerprint.slice(0, FINGERPRINT_SHOWN)}…)`,
    );
  lap("verify");
  if (manifest.abi !== abiKey)
    throw new TrustError(
      `${origin}: bundle built for runtime ABI ${manifest.abi}, this Client has ${abiKey}`,
    );
  const cached = join(store, "bundles", `${manifest.sha256}.js`);
  let code = await readFile(cached, "utf8").catch(() => undefined);
  const hit = code !== undefined && sha256(code) === manifest.sha256;
  if (!hit) {
    const response = await fetch(`${url}/bundle`);
    code = await response.text();
    lap("download");
    if (sha256(code) !== manifest.sha256)
      throw new TrustError(`${origin}: bundle does not match the signed hash`);
    await mkdir(join(store, "bundles"), { recursive: true });
    const temp = `${cached}.${crypto.randomUUID()}`;
    await Bun.write(temp, code);
    await rename(temp, cached);
  }
  lap(hit ? "cache" : "hash");
  if (!pinned) {
    known[origin] = { fingerprint, pinnedAt: new Date().toISOString() };
    await mkdir(store, { recursive: true });
    await Bun.write(knownFile, JSON.stringify(known, null, 2));
  }
  if (code === undefined) throw new TrustError(`${origin}: no bundle`);
  return { origin, manifest, code, cacheHit: hit, timings };
}
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
