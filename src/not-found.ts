/**
 * `notFound()` crosses Flight as an error digest: the one field of a Server error that
 * production Flight forwards to the Client. It carries only what the page chose to say.
 */
import * as z from "zod/mini";
import { errorDigest } from "./guards";

const PREFIX = "airtty:not-found:";
// What the page gave `notFound()`, encoded in the digest: a name or nothing.
const What = z.nullable(z.string());

export class NotFoundError extends Error {
  readonly digest: string;
  readonly what: string | undefined;
  constructor(what?: string) {
    super(what ? `${what} not found` : "Not found");
    this.what = what;
    this.digest = PREFIX + JSON.stringify(what ?? null);
  }
}

/** The Flight digest of a Server error: a not-found keeps its own, anything else is opaque. */
export function digestOf(error: unknown) {
  const digest = errorDigest(error);
  return typeof digest === "string" && digest.startsWith(PREFIX) ? digest : "Server render failed";
}

/** `{ what }` when `error` is a not-found raised by a Server page, else `null`. */
export function readNotFound(error: unknown): { what?: string } | null {
  if (error instanceof NotFoundError) return { what: error.what };
  const digest = errorDigest(error);
  if (typeof digest !== "string" || !digest.startsWith(PREFIX)) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(digest.slice(PREFIX.length));
  } catch {
    return {};
  }
  const what = What.safeParse(decoded).data;
  return typeof what === "string" ? { what } : {};
}
