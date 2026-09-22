import type { ReactNode } from "react";
import { setTimeout as delay } from "node:timers/promises";
import { decode, encodeReply } from "./flight/client";

export class TransportError extends Error {}
export class BuildMismatch extends TransportError {}
export class AuthenticationRequired extends TransportError {
  constructor(
    message: string,
    readonly loginPath?: string,
  ) {
    super(message);
  }
}

export type RouteParams = Record<string, string>;
/** URL search values: strings only, validated again by the Server. */
export type RouteSearch = Record<string, string>;

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
  ): Promise<ReactNode>;
  call(actionId: string, args: unknown[], signal?: AbortSignal): Promise<unknown>;
  setToken(token?: string): void;
}

export type HttpTransportOptions = {
  url: string;
  buildId: string;
  token?: string;
  timeoutMs?: number;
  /** Additional simulated round-trip latency for every application request. */
  latencyMs?: number;
  fetch?: typeof fetch;
  /** Receives Server Function calls made by references decoded from Flight. */
  callServer: (id: string, args: unknown[]) => Promise<unknown>;
};

export function createHttpTransport(options: HttpTransportOptions): Transport {
  const latencyMs = options.latencyMs ?? 0;
  if (!Number.isFinite(latencyMs) || latencyMs < 0)
    throw new Error("latencyMs must be a finite non-negative number");
  let token = options.token;

  // The timeout bounds the wait for the root model, not the stream behind it: a
  // Suspense boundary or an async iterable may legitimately stream for longer.
  async function request(path: string, init: RequestInit, cancel?: AbortSignal) {
    const headers = new Headers(init.headers);
    headers.set("x-airtty-build", options.buildId);
    if (token) headers.set("authorization", `Bearer ${token}`);
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new DOMException("The operation timed out.", "TimeoutError")),
      options.timeoutMs ?? 10000,
    );
    const settle = () => clearTimeout(timer);
    const signal = cancel ? AbortSignal.any([deadline.signal, cancel]) : deadline.signal;
    const oneWayMs = latencyMs / 2;
    try {
      if (oneWayMs) await delay(oneWayMs, undefined, { signal });
      const response = await (options.fetch ?? fetch)(new URL(path, options.url), {
        ...init,
        headers,
        signal,
      });
      if (oneWayMs) await delay(oneWayMs, undefined, { signal });
      if (response.status === 409) throw new BuildMismatch(await response.text());
      if (response.status === 401)
        throw new AuthenticationRequired(
          await response.text(),
          response.headers.get("x-airtty-login") ?? undefined,
        );
      if (!response.ok)
        throw new TransportError(`HTTP ${response.status}: ${await response.text()}`);
      return { response, settle };
    } catch (e) {
      settle();
      throw e instanceof TransportError
        ? e
        : new TransportError(e instanceof Error ? e.message : String(e));
    }
  }

  return {
    async render(routeId, params, signal, search = {}) {
      // Detach the stream from the caller once the root model is decoded: a cached
      // tree must keep receiving its Suspense chunks after its route is left.
      const stream = new AbortController();
      const cancel = () => stream.abort(signal.reason);
      if (signal.aborted) cancel();
      signal.addEventListener("abort", cancel);
      try {
        const query = new URLSearchParams({ route: routeId, params: JSON.stringify(params) });
        if (Object.keys(search).length) query.set("search", JSON.stringify(search));
        const { response, settle } = await request(`/render?${query}`, {}, stream.signal);
        try {
          return (await decode(response.body!, options.callServer)) as ReactNode;
        } catch (e) {
          throw e instanceof TransportError
            ? e
            : new TransportError(e instanceof Error ? e.message : String(e));
        } finally {
          settle();
        }
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    },
    async call(actionId, args, signal) {
      const callId = crypto.randomUUID();
      const { response, settle } = await request(
        "/action",
        {
          method: "POST",
          headers: { "x-airtty-action": actionId, "x-airtty-call": callId },
          body: await encodeReply(args),
        },
        signal,
      );
      const envelope = (await Promise.resolve(decode(response.body!, options.callServer)).finally(
        settle,
      )) as {
        kind?: string;
        callId?: string;
        value?: unknown;
      };
      if (envelope?.kind !== "result" || envelope.callId !== callId)
        throw new TransportError("Invalid action response");
      return envelope.value;
    },
    setToken(next) {
      token = next;
    },
  };
}
