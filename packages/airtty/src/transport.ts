import { isValidElement, type ReactNode } from "react";
import { setTimeout as delay } from "node:timers/promises";
import * as z from "zod/mini";
import { decode, encodeReply } from "./flight/client";
import { errorDigest, isAsyncIterable, messageOf } from "./guards";

/**
 * What a failed request says about its effect on the Server. The transport reports it;
 * retrying, resolving or showing it is the application's decision.
 * - `not-sent`: the request never reached the Server; nothing ran.
 * - `rejected`: the Server refused it before running any application code (4xx).
 * - `unknown`: it may have run (timeout, lost or cut response, Server error).
 */
export type Outcome = "not-sent" | "rejected" | "unknown";
export class TransportError extends Error {
  /** Defaults to `unknown`: the transport never claims a certainty it does not have. */
  readonly outcome: Outcome;
  constructor(message: string, outcome: Outcome = "unknown") {
    super(message);
    this.outcome = outcome;
  }
}
export class BuildMismatch extends TransportError {
  constructor(message: string) {
    super(message, "rejected");
  }
}
export class AuthenticationRequired extends TransportError {
  readonly loginPath: string | undefined;
  constructor(message: string, loginPath?: string) {
    super(message, "rejected");
    this.loginPath = loginPath;
  }
}
// Bun and Node codes for a connection that was never established.
const NOT_CONNECTED = new Set([
  "ConnectionRefused",
  "ECONNREFUSED",
  "FailedToOpenSocket",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);
const STATUS = { unauthorized: 401, conflict: 409, serverError: 500 } as const;
const DEFAULT_TIMEOUT_MS = 10_000;
// A Flight error with a digest was raised by Server code and reached the Client intact:
// an application error, kept as is. Anything else while decoding is the transport's.
const decodeFailure = (e: unknown) =>
  e instanceof TransportError || typeof errorDigest(e) === "string"
    ? e
    : new TransportError(messageOf(e));
const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" &&
  value !== null &&
  "then" in value &&
  typeof value.then === "function";

/**
 * What React accepts as children, checked at its top level: Flight resolves nested
 * elements, lazy chunks and Suspense content itself.
 */
export function isReactNode(value: unknown): value is ReactNode {
  if (value === null || value === undefined) return true;
  if (["string", "number", "bigint", "boolean"].includes(typeof value)) return true;
  return isValidElement(value) || Array.isArray(value) || isThenable(value);
}

// A stream returned by a Server Function fails like its request: a cut connection
// becomes a TransportError (`unknown`), a Server error keeps its digest.
function guardStream(value: unknown) {
  if (!isAsyncIterable(value)) return value;
  return {
    async *[Symbol.asyncIterator]() {
      try {
        yield* value;
      } catch (e) {
        throw decodeFailure(e);
      }
    },
  };
}

/**
 * What the Server's `/action` answers (see src/server.ts). The value keeps its Flight
 * references and streams: it is not copied, only checked to be there.
 */
const ActionEnvelope = z.object({
  kind: z.literal("result"),
  callId: z.string(),
  value: z.unknown(),
  invalidate: z.array(z.string()),
  /** Cache tags the Server Function invalidated with `invalidate({ tag })`. */
  tags: z.optional(z.array(z.string())),
});

/** What the Server's `/render` answers (src/cache/render.ts), checked to be there. */
const RenderModel = z.object({
  tree: z.custom<ReadableStream<Uint8Array>>((value) => value instanceof ReadableStream),
  tags: z.custom<PromiseLike<unknown>>(isThenable),
});
const Tags = z.array(z.string());

export type RouteParams = Record<string, string>;
/** URL search values: strings only, validated again by the Server. */
export type RouteSearch = Record<string, string>;

/**
 * Why the Client sends a request, as far as it can tell: `preload` is TanStack's
 * preloading, `refresh` the user's own reload, `invalidation` one declared by
 * `invalidate()` (Server or Client), `live` a `useLive` subscription. Anything the
 * Client cannot attribute is `unknown`.
 */
export type RequestCause =
  | "navigation"
  | "preload"
  | "refresh"
  | "invalidation"
  | "action"
  | "live"
  | "unknown";
/**
 * What the caller knows about a request that the request itself does not carry, and
 * `onTags`, told the "use cache" tags a rendered page read once its render ended, Suspense
 * content included (after `render` resolved; never if the stream is cut).
 */
export type RequestContext = { cause?: RequestCause; onTags?: (tags: readonly string[]) => void };

/**
 * The only way the Client reaches a Server. `render` resolves with the root Flight
 * model; nested Suspense content and async iterables keep streaming after it.
 * Aborting `signal` and the request timeout both apply only until that root model
 * arrives. Failures are `TransportError`s.
 */
export interface Transport {
  render(
    routeId: string,
    params: RouteParams,
    signal: AbortSignal,
    search?: RouteSearch,
    context?: RequestContext,
  ): Promise<ReactNode>;
  call(
    actionId: string,
    args: unknown[],
    signal?: AbortSignal,
    context?: RequestContext,
  ): Promise<unknown>;
  setToken(token?: string): void;
}

/**
 * What the transport observes, request by request: for an overlay, logs or tracing.
 * `id` correlates the events of one request in this Client; `callId` is sent as
 * `x-airtty-call` and correlates it with the Server's own events. `target` is its route
 * or Server Function; `at` is when the event happened, in epoch milliseconds.
 */
export type TransportEvent = {
  id: number;
  callId: string;
  at: number;
  kind: "render" | "action";
  target: string;
} & (
  | { type: "request"; cause: RequestCause }
  | { type: "response"; status: number; ms: number }
  | { type: "chunk"; bytes: number }
  | { type: "end"; ms: number; bytes: number; cancelled: boolean }
  | { type: "error"; ms: number; outcome: Outcome; message: string }
);
type RequestMeta = { kind: "render" | "action"; target: string };
type Tag = RequestMeta & { id: number; callId: string };
/** Epoch milliseconds from the monotonic clock durations use: `at` and `ms` agree. */
export const now = () => performance.timeOrigin + performance.now();
/**
 * Simulated faults, for testing an application's own handling:
 * - `refuse`: the request is never sent (`not-sent`);
 * - `drop`: the Server answers, the response is lost (`unknown`; the Server ran);
 * - `cut`: the body fails before its first byte (`unknown`).
 */
const FAULTS = ["refuse", "drop", "cut"] as const;
export type Fault = (typeof FAULTS)[number];
const FaultEntry = z.object({
  type: z.enum(FAULTS),
  p: z.number().check(z.gte(0), z.lte(1)),
});
const Milliseconds = z.coerce.number().check(z.gte(0));
/** Development network conditions, on top of `latencyMs`. Not a TCP emulation. */
export type NetworkConditions = {
  /** Random extra delay, 0 to `jitterMs`, added to each direction of each request. */
  jitterMs?: number;
  /** Delay before each body chunk reaches the decoder: slow streams, Suspense included. */
  chunkDelayMs?: number;
  /** Chooses a fault per request, or none. */
  fault?: (request: RequestMeta) => Fault | undefined;
};
/**
 * Reads `AIRTTY_JITTER_MS`, `AIRTTY_CHUNK_DELAY_MS` and `AIRTTY_FAULT`
 * (`refuse:0.1,drop:0.05,cut:0.05`: a probability per fault, checked in that order).
 */
export function networkFromEnv(env: Record<string, string | undefined>): NetworkConditions {
  const number = (name: string) => {
    const value = Milliseconds.safeParse(env[name] ?? 0);
    if (!value.success) throw new Error(`${name} must be a number ≥ 0`);
    return value.data;
  };
  const faults = (env.AIRTTY_FAULT ?? "")
    .split(",")
    .filter(Boolean)
    .map((entry) => {
      const [type, probability] = entry.split(":");
      const fault = FaultEntry.safeParse({ type, p: Number(probability ?? 1) });
      if (!fault.success) throw new Error(`AIRTTY_FAULT: invalid entry "${entry}"`);
      return fault.data;
    });
  return {
    jitterMs: number("AIRTTY_JITTER_MS"),
    chunkDelayMs: number("AIRTTY_CHUNK_DELAY_MS"),
    fault: faults.length ? () => faults.find(({ p }) => Math.random() < p)?.type : undefined,
  };
}

/** What the transport calls to send a request: `fetch` itself, or any stand-in. */
export type Fetch = (input: URL, init: RequestInit) => Promise<Response>;

export type HttpTransportOptions = {
  url: string;
  buildId: string;
  /**
   * The pane's instance key, sent as `x-airtty-instance`: the Server prefixes the Client
   * Reference ids it writes with it (`<key>@<buildId>/<path>`). Set by a host, never by
   * an application.
   */
  instance?: string;
  token?: string;
  timeoutMs?: number;
  /** Additional simulated round-trip latency for every application request. */
  latencyMs?: number;
  fetch?: Fetch;
  /** Receives Server Function calls made by references decoded from Flight. */
  callServer: (id: string, args: unknown[]) => Promise<unknown>;
  /** Paths and cache tags a successful Server Function declared changed (`invalidate()`). */
  onInvalidate?: (paths: string[], tags: string[]) => void;
  /** Every request's lifecycle, chunks included; see `TransportEvent`. */
  onEvent?: (event: TransportEvent) => void;
  network?: NetworkConditions;
};

export function createHttpTransport(options: HttpTransportOptions): Transport {
  const latencyMs = options.latencyMs ?? 0;
  if (!Number.isFinite(latencyMs) || latencyMs < 0)
    throw new Error("latencyMs must be a finite non-negative number");
  let token = options.token;
  let sequence = 0;
  const emit = options.onEvent ?? (() => {});
  const network = options.network ?? {};
  for (const [name, value] of Object.entries({
    jitterMs: network.jitterMs,
    chunkDelayMs: network.chunkDelayMs,
  }))
    if (value !== undefined && !(Number.isFinite(value) && value >= 0))
      throw new Error(`${name} must be a finite non-negative number`);
  const oneWay = () => latencyMs / 2 + Math.random() * (network.jitterMs ?? 0);

  // Counts what the caller actually reads: chunks, bytes, the end or the failure of the
  // body, so a stream that outlives its request still reports how it ended.
  function observe(body: ReadableStream<Uint8Array> | null, tag: Tag, start: number, cut: boolean) {
    let bytes = 0;
    const ms = () => Math.round(performance.now() - start);
    if (!body) {
      emit({ ...tag, at: now(), type: "end", ms: ms(), bytes, cancelled: false });
      return new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
    }
    const reader = body.getReader();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (cut) {
            await reader.cancel();
            throw new TransportError("Simulated cut connection");
          }
          const { done, value } = await reader.read();
          if (done) {
            emit({ ...tag, at: now(), type: "end", ms: ms(), bytes, cancelled: false });
            controller.close();
            return;
          }
          bytes += value.byteLength;
          if (network.chunkDelayMs) await delay(network.chunkDelayMs);
          emit({ ...tag, at: now(), type: "chunk", bytes: value.byteLength });
          controller.enqueue(value);
        } catch (e) {
          emit({
            ...tag,
            at: now(),
            type: "error",
            ms: ms(),
            outcome: "unknown",
            message: messageOf(e),
          });
          controller.error(e);
        }
      },
      cancel(reason) {
        emit({ ...tag, at: now(), type: "end", ms: ms(), bytes, cancelled: true });
        return reader.cancel(reason);
      },
    });
  }

  // The timeout bounds the wait for the root model, not the stream behind it: a
  // Suspense boundary or an async iterable may legitimately stream for longer.
  async function request(
    path: string,
    init: RequestInit,
    meta: RequestMeta,
    cancel: AbortSignal | undefined,
    context: RequestContext = {},
  ) {
    const tag: Tag = { id: ++sequence, callId: crypto.randomUUID(), ...meta };
    const start = performance.now();
    emit({ ...tag, at: now(), type: "request", cause: context.cause ?? "unknown" });
    const headers = new Headers(init.headers);
    headers.set("x-airtty-build", options.buildId);
    headers.set("x-airtty-call", tag.callId);
    if (options.instance) headers.set("x-airtty-instance", options.instance);
    if (token) headers.set("authorization", `Bearer ${token}`);
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new DOMException("The operation timed out.", "TimeoutError")),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    const settle = () => clearTimeout(timer);
    const signal = cancel ? AbortSignal.any([deadline.signal, cancel]) : deadline.signal;
    const fault = network.fault?.(meta);
    try {
      // Before fetch starts, a failure or cancellation provably sent nothing.
      try {
        const before = oneWay();
        if (before) await delay(before, undefined, { signal });
        signal.throwIfAborted();
        if (fault === "refuse") throw new Error("Simulated refused connection");
      } catch (e) {
        throw new TransportError(messageOf(e), "not-sent");
      }
      let response: Response;
      try {
        response = await (options.fetch ?? fetch)(new URL(path, options.url), {
          ...init,
          headers,
          signal,
        });
      } catch (e) {
        const code = typeof e === "object" && e !== null && "code" in e ? e.code : undefined;
        throw new TransportError(
          messageOf(e),
          typeof code === "string" && NOT_CONNECTED.has(code) ? "not-sent" : "unknown",
        );
      }
      const after = oneWay();
      if (after) await delay(after, undefined, { signal });
      if (fault === "drop") {
        await response.body?.cancel();
        throw new TransportError("Simulated lost response");
      }
      if (response.status === STATUS.conflict) throw new BuildMismatch(await response.text());
      if (response.status === STATUS.unauthorized)
        throw new AuthenticationRequired(
          await response.text(),
          response.headers.get("x-airtty-login") ?? undefined,
        );
      // The Server answers 4xx only before running application code; a 5xx may follow it.
      if (!response.ok)
        throw new TransportError(
          `HTTP ${response.status}: ${await response.text()}`,
          response.status < STATUS.serverError ? "rejected" : "unknown",
        );
      emit({
        ...tag,
        at: now(),
        type: "response",
        status: response.status,
        ms: Math.round(performance.now() - start),
      });
      return {
        body: observe(response.body, tag, start, fault === "cut"),
        settle,
        callId: tag.callId,
      };
    } catch (e) {
      settle();
      const error = e instanceof TransportError ? e : new TransportError(messageOf(e));
      emit({
        ...tag,
        at: now(),
        type: "error",
        ms: Math.round(performance.now() - start),
        outcome: error.outcome,
        message: error.message,
      });
      throw error;
    }
  }

  return {
    async render(routeId, params, signal, search = {}, context) {
      // Detach the stream from the caller once the root model is decoded: a cached
      // tree must keep receiving its Suspense chunks after its route is left.
      const stream = new AbortController();
      const cancel = () => stream.abort(signal.reason);
      if (signal.aborted) cancel();
      signal.addEventListener("abort", cancel);
      try {
        const query = new URLSearchParams({ route: routeId, params: JSON.stringify(params) });
        if (Object.keys(search).length) query.set("search", JSON.stringify(search));
        const { body, settle } = await request(
          `/render?${query}`,
          {},
          { kind: "render", target: routeId },
          stream.signal,
          context,
        );
        let tree: unknown;
        try {
          // `{ tree, tags }` (src/cache/render.ts): the page is a Flight stream of its own.
          const page = RenderModel.safeParse(await decode(body, options.callServer));
          if (!page.success) throw new TransportError("Invalid render response");
          tree = await decode(page.data.tree, options.callServer);
          page.data.tags.then(
            (read) => {
              const tags = Tags.safeParse(read);
              if (tags.success) context?.onTags?.(tags.data);
            },
            () => {},
          );
        } catch (e) {
          throw decodeFailure(e);
        } finally {
          settle();
        }
        if (!isReactNode(tree)) throw new TransportError("Invalid render response");
        return tree;
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    },
    async call(actionId, args, signal, context) {
      const { body, settle, callId } = await request(
        "/action",
        {
          method: "POST",
          headers: { "x-airtty-action": actionId },
          body: await encodeReply(args),
        },
        { kind: "action", target: actionId },
        signal,
        context,
      );
      const decoded = await Promise.resolve(decode(body, options.callServer))
        .catch((e: unknown) => {
          throw decodeFailure(e);
        })
        .finally(settle);
      const envelope = ActionEnvelope.safeParse(decoded);
      if (!envelope.success || envelope.data.callId !== callId)
        throw new TransportError("Invalid action response");
      const { invalidate, tags = [], value } = envelope.data;
      if (invalidate.length || tags.length) options.onInvalidate?.(invalidate, tags);
      return guardStream(value);
    },
    setToken(next) {
      token = next;
    },
  };
}
