// oxlint-disable-next-line typescript/triple-slash-reference -- the ambient Flight declarations (see src/flight/server.ts).
/// <reference path="../../types.d.ts" />
import { createHash } from "node:crypto";
import { encodeReply } from "react-server-dom-webpack/client.node";
import { decodeReply } from "../flight/server";
import { isAsyncIterable, messageOf } from "../guards";

/**
 * Arguments and results of `"use cache"` functions travel through React's reply codec,
 * the one Server Function arguments use: Dates, Maps, Sets, BigInts, `undefined` and
 * nested references survive, and encoding the same value twice gives the same text, so
 * it also serves as the cache key. Elements, Client functions and Blobs are refused.
 */
type Encoded = string | [name: string, part: string][];

// A stream is read once and may never end: neither a key nor a stored value can hold it.
function assertFinite(value: unknown, what: string, seen = new Set<unknown>()) {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  if (isAsyncIterable(value) || value instanceof ReadableStream)
    throw new Error(`"use cache" ${what} cannot be a stream or async iterable`);
  const children =
    value instanceof Map
      ? [...value.keys(), ...value.values()]
      : value instanceof Set || Array.isArray(value)
        ? [...value]
        : Object.values(value);
  for (const child of children) assertFinite(child, what, seen);
}

async function encode(value: unknown, what: string): Promise<Encoded> {
  assertFinite(value, what);
  let body: string | FormData;
  try {
    body = await encodeReply(value);
  } catch (error) {
    throw new Error(`"use cache" ${what} is not serializable: ${messageOf(error)}`);
  }
  if (typeof body === "string") return body;
  const parts: [string, string][] = [];
  for (const [name, part] of body.entries()) {
    if (typeof part !== "string") throw new Error(`"use cache" ${what} cannot hold a Blob`);
    parts.push([name, part]);
  }
  return parts;
}

/** The stored form of a result: text for any `CacheHandler`. */
export async function encodeValue(value: unknown) {
  return JSON.stringify(await encode(value, "result"));
}

/** A fresh copy of a stored result: callers never share a mutable object. */
export function decodeValue(stored: string): Promise<unknown> {
  const encoded: unknown = JSON.parse(stored);
  if (typeof encoded === "string") return decodeReply(encoded, {});
  if (!Array.isArray(encoded)) throw new Error("Corrupt cache entry");
  const form = new FormData();
  const parts: unknown[] = encoded;
  for (const part of parts) {
    if (!Array.isArray(part) || typeof part[0] !== "string" || typeof part[1] !== "string")
      throw new Error("Corrupt cache entry");
    form.append(part[0], part[1]);
  }
  return decodeReply(form, {});
}

/** Function id, build and arguments: a new build never reads another build's entries. */
export async function keyOf(buildId: string, fn: string, args: unknown[]) {
  const encoded = JSON.stringify(await encode(args, "arguments"));
  return createHash("sha256").update(`${buildId}\0${fn}\0${encoded}`).digest("hex");
}
