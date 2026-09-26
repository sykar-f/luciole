/**
 * `base64url` for the browser's `Buffer`. Bun's browser polyfill of `node:buffer` knows
 * base64 but not its URL-safe form, which Server code uses for tokens (examples/forge:
 * `toString("base64url")`) and which throws "Unknown encoding" there. Encoding goes through
 * base64 and swaps the alphabet; nothing changes where the encoding is already known.
 */
import { Buffer } from "node:buffer";

const toUrl = (base64: string) =>
  base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const fromUrl = (url: string) => url.replaceAll("-", "+").replaceAll("_", "/");
const isUrl = (encoding: unknown) =>
  typeof encoding === "string" && encoding.toLowerCase() === "base64url";

if (!Buffer.isEncoding("base64url")) {
  const toString: unknown = Reflect.get(Buffer.prototype, "toString");
  if (typeof toString !== "function") throw new Error("Buffer has no toString to extend");
  const from = Buffer.from.bind(Buffer);
  const isEncoding = Buffer.isEncoding.bind(Buffer);
  const byteLength = Buffer.byteLength.bind(Buffer);
  Object.assign(Buffer.prototype, {
    toString(this: Buffer, encoding?: string, start?: number, end?: number) {
      const url = isUrl(encoding);
      const text = String(Reflect.apply(toString, this, [url ? "base64" : encoding, start, end]));
      return url ? toUrl(text) : text;
    },
  });
  // The originals take whatever the caller gave: their own checks still apply to it.
  Object.assign(Buffer, {
    from(value: unknown, encoding?: unknown, length?: unknown): unknown {
      return typeof value === "string" && isUrl(encoding)
        ? from(fromUrl(value), "base64")
        : Reflect.apply(from, Buffer, [value, encoding, length]);
    },
    isEncoding: (encoding: string) => isUrl(encoding) || isEncoding(encoding),
    byteLength(value: unknown, encoding?: unknown): unknown {
      return typeof value === "string" && isUrl(encoding)
        ? byteLength(fromUrl(value), "base64")
        : Reflect.apply(byteLength, Buffer, [value, encoding]);
    },
  });
}
