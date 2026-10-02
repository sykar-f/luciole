/**
 * Type guards shared by the Server and the Client, for values whose type only the
 * runtime knows: thrown errors and Server Function results.
 */
export const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> =>
  typeof value === "object" &&
  value !== null &&
  Symbol.asyncIterator in value &&
  typeof value[Symbol.asyncIterator] === "function";

/** The `digest` of an error raised by Server code, as Flight forwards it. */
export const errorDigest = (error: unknown): unknown =>
  typeof error === "object" && error !== null && "digest" in error ? error.digest : undefined;
