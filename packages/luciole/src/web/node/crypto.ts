/**
 * `node:crypto` in a page: randomness is the page's own `crypto`. `createHash` hashes
 * synchronously, SHA-256 only (sha256.ts): the in-browser Server's code needs it where
 * SubtleCrypto's promise cannot be awaited.
 */
import { Buffer } from "node:buffer";
import { Sha256Hasher } from "./sha256";

export const randomUUID = () => globalThis.crypto.randomUUID();
export const getRandomValues = <T extends ArrayBufferView>(array: T) =>
  globalThis.crypto.getRandomValues(array);
export const randomBytes = (size: number) =>
  Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(size)));
export const createHash = (algorithm: string) => new Sha256Hasher(algorithm);
export default { createHash, randomUUID, getRandomValues, randomBytes };
