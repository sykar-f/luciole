/**
 * SHA-256, synchronous, for the in-browser Server (docs/WEB.md, W9). Server code hashes in
 * the middle of a synchronous `bun:sqlite` transaction (examples/forge: session tokens),
 * where SubtleCrypto's promise cannot be awaited. FIPS 180-4, checked against Bun's hasher
 * (tests/web-sha256.test.ts). `Bun.CryptoHasher` and `createHash` offer it by that name.
 */
import { Buffer } from "node:buffer";

/** FIPS 180-4 § 4.2.2: one constant per round. */
const ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const K = Uint32Array.from(ROUND_CONSTANTS);
const INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];
const BLOCK = 64;
const ROUNDS = 64;
const LENGTH_BYTES = 8;
const WORD_BITS = 32;
const WORD_BYTES = 4;

const rotr = (x: number, n: number) => (x >>> n) | (x << (WORD_BITS - n));
/** FIPS 180-4 § 4.1.2: two rotations, then a rotation (Σ) or a shift (σ). */
const SIGMA = {
  big0: [2, 13, 22],
  big1: [6, 11, 25],
  small0: [7, 18, 3],
  small1: [17, 19, 10],
} as const;
const big = ([x, y, z]: readonly [number, number, number], v: number) =>
  rotr(v, x) ^ rotr(v, y) ^ rotr(v, z);
const small = ([x, y, z]: readonly [number, number, number], v: number) =>
  rotr(v, x) ^ rotr(v, y) ^ (v >>> z);

/** The SHA-256 digest of `data`. */
export function sha256(data: Uint8Array): Uint8Array {
  // The message, a 0x80 byte, zeros, then its length in bits: a whole number of blocks.
  const padded = new Uint8Array(Math.ceil((data.length + 1 + LENGTH_BYTES) / BLOCK) * BLOCK);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = data.length * 8;
  view.setUint32(padded.length - LENGTH_BYTES, Math.floor(bits / 2 ** WORD_BITS));
  view.setUint32(padded.length - WORD_BYTES, bits >>> 0);

  const h = Uint32Array.from(INITIAL);
  const w = new Uint32Array(ROUNDS);
  for (let offset = 0; offset < padded.length; offset += BLOCK) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * WORD_BYTES);
    for (let i = 16; i < ROUNDS; i++) {
      w[i] = w[i - 16] + small(SIGMA.small0, w[i - 15]) + w[i - 7] + small(SIGMA.small1, w[i - 2]);
    }
    let [a, b, c, d, e, f, g, hh] = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]];
    for (let i = 0; i < ROUNDS; i++) {
      const t1 = hh + big(SIGMA.big1, e) + ((e & f) ^ (~e & g)) + K[i] + w[i];
      const t2 = big(SIGMA.big0, a) + ((a & b) ^ (a & c) ^ (b & c));
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, hh].forEach((value, i) => (h[i] = h[i] + value));
  }
  const digest = new Uint8Array(h.length * WORD_BYTES);
  const out = new DataView(digest.buffer);
  h.forEach((value, i) => out.setUint32(i * WORD_BYTES, value));
  return digest;
}

type Input = string | ArrayBufferView | ArrayBuffer;
const bytes = (input: Input) =>
  typeof input === "string"
    ? new TextEncoder().encode(input)
    : input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);

/**
 * The hasher `Bun.CryptoHasher` and `createHash` return: `update` as often as needed, then
 * one `digest`, as bytes or in an encoding. Only SHA-256: anything else says so.
 */
export class Sha256Hasher {
  private readonly parts: Uint8Array[] = [];

  constructor(algorithm: string) {
    if (algorithm.toLowerCase() !== "sha256")
      throw new Error(`${algorithm} is not available in the browser runtime, only sha256`);
  }

  update(input: Input) {
    this.parts.push(bytes(input));
    return this;
  }

  digest(): Buffer;
  digest(encoding: BufferEncoding): string;
  digest(encoding?: BufferEncoding): Buffer | string {
    const all = new Uint8Array(this.parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of this.parts) {
      all.set(part, at);
      at += part.length;
    }
    const digest = Buffer.from(sha256(all));
    return encoding ? digest.toString(encoding) : digest;
  }
}
