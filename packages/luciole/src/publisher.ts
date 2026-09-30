/**
 * The publisher's key: an Ed25519 key that signs an application bundle's manifest
 * (docs/EMBEDDING.md, step 4), so that a Client can tell the bundle it evaluates is the
 * one its publisher built. Not the macOS Developer ID signature of the Client binary
 * (src/sign.ts): that one is Apple's, for Gatekeeper; this one is luciole's, for hosts.
 *
 * The private key never enters a build directory: it lives in the user's configuration
 * (`$XDG_CONFIG_HOME/luciole/keys/publisher.pem`, or `LUCIOLE_PUBLISHER_KEY`), 0600 in a
 * 0700 directory, refused if others can read it (as ssh refuses a key).
 *
 * What is signed is a canonical encoding of the manifest's fields, never the JSON as
 * received: key order, spacing or added fields cannot change what a signature covers.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppManifest } from "./abi";
import { directories } from "./launcher/paths";

const PRIVATE_FILE = 0o600;
const PRIVATE_DIRECTORY = 0o700;
const OTHERS = 0o077;
// Tells a luciole manifest signature from any other use of the same key.
const DOMAIN = "luciole application manifest v1\n";

export const publisherKeyFile = (env: NodeJS.ProcessEnv = process.env) =>
  env.LUCIOLE_PUBLISHER_KEY || join(directories(env).config, "keys", "publisher.pem");

/** `SHA256:<base64>` of the public key (SPKI DER), as ssh shows host keys. */
export const fingerprintOf = (publicKey: string) =>
  `SHA256:${createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("base64").replace(/=+$/, "")}`;
const spki = (key: KeyObject) =>
  createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64");

export type PublisherKey = { file: string; privateKey: KeyObject; publicKey: string };
export function publisherIdentity(key: Pick<PublisherKey, "file" | "publicKey">) {
  return { file: key.file, publicKey: key.publicKey, fingerprint: fingerprintOf(key.publicKey) };
}

/**
 * Creates the key. An existing one is never replaced: every host that pinned it would
 * then refuse this publisher's bundles; moving it away is a decision, not a flag.
 */
export function generatePublisherKey(env: NodeJS.ProcessEnv = process.env) {
  const file = publisherKeyFile(env);
  if (existsSync(file))
    throw new Error(
      `${file} exists: replacing it would make hosts that trust it refuse your bundles. Move it away first.`,
    );
  mkdirSync(dirname(file), { recursive: true, mode: PRIVATE_DIRECTORY });
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" });
  // `wx`: created here or not at all, 0600 from the first byte.
  writeFileSync(file, pem, { mode: PRIVATE_FILE, flag: "wx" });
  chmodSync(file, PRIVATE_FILE);
  return publisherIdentity({ file, publicKey: spki(privateKey) });
}

export function readPublisherKey(env: NodeJS.ProcessEnv = process.env): PublisherKey {
  const file = publisherKeyFile(env);
  if (!existsSync(file))
    throw new Error(`No publisher key at ${file}: create one with \`luciole keys generate\``);
  if ((statSync(file).mode & OTHERS) !== 0)
    throw new Error(`${file} is readable by others: chmod 600 it (a publisher key is a secret)`);
  const privateKey = createPrivateKey(readFileSync(file));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error(`${file} is not an Ed25519 key`);
  return { file, privateKey, publicKey: spki(privateKey) };
}

/** JSON with object keys sorted, recursively: one text per value. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
/** The bytes a signature covers: every field of the manifest, in a fixed order. */
export function signedBytes(manifest: AppManifest, publicKey: string) {
  const fields = [
    manifest.format,
    manifest.name,
    manifest.buildId,
    manifest.abi,
    manifest.bundle,
    manifest.sha256,
    manifest.size,
    manifest.builtins,
    manifest.capabilities ?? null,
    publicKey,
  ];
  return new TextEncoder().encode(DOMAIN + canonicalJson(fields));
}

/** The manifest with its publisher's signature. */
export function signManifest(manifest: AppManifest, key: PublisherKey): AppManifest {
  const { signature: _previous, ...unsigned } = manifest;
  const value = sign(null, signedBytes(unsigned, key.publicKey), key.privateKey);
  return { ...unsigned, signature: { publicKey: key.publicKey, value: value.toString("base64") } };
}

/**
 * The fingerprint of the key that signed `manifest`, `undefined` when it is unsigned.
 * A signature that does not verify throws: a bundle is signed right or refused.
 */
export function verifyManifest(manifest: AppManifest): string | undefined {
  const { signature } = manifest;
  if (!signature) return undefined;
  const key = createPublicKey({
    key: Buffer.from(signature.publicKey, "base64"),
    format: "der",
    type: "spki",
  });
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error(`${manifest.name}: the manifest is signed with a key that is not Ed25519`);
  const valid = verify(
    null,
    signedBytes(manifest, signature.publicKey),
    key,
    Buffer.from(signature.value, "base64"),
  );
  if (!valid) throw new Error(`${manifest.name}: the manifest signature does not verify`);
  return fingerprintOf(signature.publicKey);
}
