import { expect, test } from "bun:test";
import {
  AuthenticationRequired,
  BuildMismatch,
  TransportError,
  createHttpTransport,
} from "../src/transport";

const base = {
  url: "http://terminal.invalid",
  buildId: "build-1",
  callServer: () => Promise.reject(new Error("unused")),
};
const stub = (respond: (url: URL, init: RequestInit) => Response | Promise<Response>) =>
  Object.assign(
    (input: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(respond(new URL(String(input)), init ?? {})),
    { preconnect: fetch.preconnect },
  );

test("render requests the route by id with build identity and the current bearer", async () => {
  const seen: {
    path: string;
    route: string | null;
    params: unknown;
    build: string | null;
    auth: string | null;
  }[] = [];
  const transport = createHttpTransport({
    ...base,
    token: "first",
    fetch: stub((url, init) => {
      const headers = new Headers(init.headers);
      seen.push({
        path: url.pathname,
        route: url.searchParams.get("route"),
        params: JSON.parse(url.searchParams.get("params") ?? "null"),
        build: headers.get("x-terminal-build"),
        auth: headers.get("authorization"),
      });
      return new Response("Unknown", { status: 404 });
    }),
  });
  const signal = new AbortController().signal;
  await expect(transport.render("/notes/[id]", { id: "a b" }, signal)).rejects.toThrow("HTTP 404");
  transport.setToken("second");
  await expect(transport.render("/", {}, signal)).rejects.toThrow(TransportError);
  transport.setToken(undefined);
  await expect(transport.render("/", {}, signal)).rejects.toThrow(TransportError);
  expect(seen).toEqual([
    {
      path: "/render",
      route: "/notes/[id]",
      params: { id: "a b" },
      build: "build-1",
      auth: "Bearer first",
    },
    { path: "/render", route: "/", params: {}, build: "build-1", auth: "Bearer second" },
    { path: "/render", route: "/", params: {}, build: "build-1", auth: null },
  ]);
});

test("build mismatch and missing session are typed failures", async () => {
  const signal = new AbortController().signal;
  const mismatch = createHttpTransport({
    ...base,
    fetch: stub(() => new Response("Incompatible build", { status: 409 })),
  });
  await expect(mismatch.render("/", {}, signal)).rejects.toBeInstanceOf(BuildMismatch);
  await expect(mismatch.call("a#b", [])).rejects.toBeInstanceOf(BuildMismatch);
  const anonymous = createHttpTransport({
    ...base,
    fetch: stub(
      () =>
        new Response("Authentication required", {
          status: 401,
          headers: { "x-terminal-login": "/login" },
        }),
    ),
  });
  const failure = await anonymous.render("/", {}, signal).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(AuthenticationRequired);
  expect((failure as AuthenticationRequired).loginPath).toBe("/login");
});

test("aborting a render before its response cancels the request", async () => {
  const controller = new AbortController();
  let received: AbortSignal | undefined;
  const transport = createHttpTransport({
    ...base,
    fetch: stub(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          received = init.signal as AbortSignal;
          received.addEventListener("abort", () => reject(received!.reason));
        }),
    ),
  });
  const pending = transport.render("/", {}, controller.signal);
  await Bun.sleep(5);
  controller.abort();
  await expect(pending).rejects.toBeInstanceOf(TransportError);
  expect(received?.aborted).toBe(true);
});

test("simulated latency validates configuration and respects the request timeout", async () => {
  for (const latencyMs of [-1, NaN, Infinity])
    expect(() => createHttpTransport({ ...base, latencyMs })).toThrow("latencyMs");
  let called = false;
  const transport = createHttpTransport({
    ...base,
    latencyMs: 500,
    timeoutMs: 20,
    fetch: stub(() => {
      called = true;
      return new Response();
    }),
  });
  await expect(transport.render("/", {}, new AbortController().signal)).rejects.toThrow();
  expect(called).toBe(false);
});
