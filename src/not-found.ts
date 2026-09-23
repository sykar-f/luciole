/**
 * `notFound()` crosses Flight as an error digest: the one field of a Server error that
 * production Flight forwards to the Client. It carries only what the page chose to say.
 */
const PREFIX = "airtty:not-found:";

export class NotFoundError extends Error {
  readonly digest: string;
  constructor(readonly what?: string) {
    super(what ? `${what} not found` : "Not found");
    this.digest = PREFIX + JSON.stringify(what ?? null);
  }
}

/** The Flight digest of a Server error: a not-found keeps its own, anything else is opaque. */
export function digestOf(error: unknown) {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return typeof digest === "string" && digest.startsWith(PREFIX) ? digest : "Server render failed";
}

/** `{ what }` when `error` is a not-found raised by a Server page, else `null`. */
export function readNotFound(error: unknown): { what?: string } | null {
  if (error instanceof NotFoundError) return { what: error.what };
  const digest = (error as { digest?: unknown } | null)?.digest;
  if (typeof digest !== "string" || !digest.startsWith(PREFIX)) return null;
  try {
    const what = JSON.parse(digest.slice(PREFIX.length));
    return typeof what === "string" ? { what } : {};
  } catch {
    return {};
  }
}
