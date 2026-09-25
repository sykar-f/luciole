/**
 * `node:crypto` in a page: randomness is the page's own `crypto`. Nothing the page runs
 * hashes synchronously (the ABI key is written into the bundle when it is built,
 * src/web/build.ts), so `createHash` says it is unavailable.
 */
import { Buffer } from "node:buffer";

export const randomUUID = () => globalThis.crypto.randomUUID();
export const getRandomValues = <T extends ArrayBufferView>(array: T) =>
  globalThis.crypto.getRandomValues(array);
export const randomBytes = (size: number) =>
  Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(size)));
export function createHash(algorithm: string): never {
  throw new Error(`createHash(${algorithm}) is not available in the browser runtime`);
}
export default { createHash, randomUUID, getRandomValues, randomBytes };
