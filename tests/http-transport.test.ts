import { expect, test } from "bun:test";
import {
  AuthenticationRequired,
  BuildMismatch,
  TransportError,
  createHttpTransport,
  type Fetch,
} from "../packages/luciole/src/transport";
import { messageOf } from "../packages/luciole/src/guards";
import { rejectionOf, renderBody } from "./helpers";

const base = {
  url: "http://terminal.invalid",
  buildId: "build-1",
  callServer: () => Promise.reject(new Error("unused")),
};
const stub =
  (respond: (url: URL, init: RequestInit) => Response | Promise<Response>): Fetch =>
  (input, init) =>
    Promise.resolve(respond(input, init));

test("render requests the route by id with build identity and the current bearer", async () => {
  const seen: {
    path: string;
    route: string | null;
    params: unknown;
    build: string | null;
    auth: string | null;
    search: unknown;
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
        build: headers.get("x-luciole-build"),
        auth: headers.get("authorization"),
        search: JSON.parse(url.searchParams.get("search") ?? "null"),
      });
      return new Response("Unknown", { status: 404 });
    }),
  });
  const signal = new AbortController().signal;
  expect(
    messageOf(await rejectionOf(transport.render("/notes/[id]", { id: "a b" }, signal))),
  ).toContain("HTTP 404");
  transport.setToken("second");
  expect(await rejectionOf(transport.render("/", {}, signal))).toBeInstanceOf(TransportError);
  transport.setToken(undefined);
  expect(
    await rejectionOf(transport.render("/", {}, signal, { q: "a&b", state: "open" })),
  ).toBeInstanceOf(TransportError);
  expect(seen).toEqual([
    {
      path: "/render",
      route: "/notes/[id]",
      params: { id: "a b" },
      build: "build-1",
      auth: "Bearer first",
      search: null,
    },
    {
      path: "/render",
      route: "/",
      params: {},
      build: "build-1",
      auth: "Bearer second",
      search: null,
    },
    {
      path: "/render",
      route: "/",
      params: {},
      build: "build-1",
      auth: null,
      search: { q: "a&b", state: "open" },
    },
  ]);
});

test("build mismatch and missing session are typed failures", async () => {
  const signal = new AbortController().signal;
  const mismatch = createHttpTransport({
    ...base,
    fetch: stub(() => new Response("Incompatible build", { status: 409 })),
  });
  expect(await rejectionOf(mismatch.render("/", {}, signal))).toBeInstanceOf(BuildMismatch);
  expect(await rejectionOf(mismatch.call("a#b", []))).toBeInstanceOf(BuildMismatch);
  const anonymous = createHttpTransport({
    ...base,
    fetch: stub(
      () =>
        new Response("Authentication required", {
          status: 401,
          headers: { "x-luciole-login": "/login" },
        }),
    ),
  });
  const failure = await rejectionOf(anonymous.render("/", {}, signal));
  expect(failure).toBeInstanceOf(AuthenticationRequired);
  expect(failure instanceof AuthenticationRequired ? failure.loginPath : undefined).toBe("/login");
});

test("aborting a render before its response cancels the request", async () => {
  const controller = new AbortController();
  let received: AbortSignal | undefined;
  const transport = createHttpTransport({
    ...base,
    fetch: stub(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init.signal;
          if (!signal) return reject(new Error("The request carries no signal"));
          received = signal;
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    ),
  });
  const pending = transport.render("/", {}, controller.signal);
  await Bun.sleep(5);
  controller.abort();
  expect(await rejectionOf(pending)).toBeInstanceOf(TransportError);
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
  await rejectionOf(transport.render("/", {}, new AbortController().signal));
  expect(called).toBe(false);
});

// A Server Function's answer is checked before its value is used: the envelope the
// Server writes (src/server.ts), for this call, with string paths only.
test("an action response outside the envelope schema is a TransportError", async () => {
  const answer = (envelope: (callId: string) => unknown) =>
    createHttpTransport({
      ...base,
      fetch: stub((_url, init) => {
        const callId = new Headers(init.headers).get("x-luciole-call") ?? "";
        // One Flight model row: the root value, as JSON.
        return new Response(`0:${JSON.stringify(envelope(callId))}\n`);
      }),
    }).call("actions/a.ts#run", []);
  const valid = (callId: string) => ({ kind: "result", callId, value: 42, invalidate: [] });
  expect(await answer(valid)).toBe(42);
  for (const invalid of [
    (callId: string) => ({ ...valid(callId), invalidate: [7] }),
    (callId: string) => ({ ...valid(callId), kind: "other" }),
    () => valid("another call"),
  ]) {
    const error = await rejectionOf(answer(invalid));
    expect(error).toBeInstanceOf(TransportError);
    expect(messageOf(error)).toBe("Invalid action response");
  }
});

test("a render whose root is not a React node is a TransportError", async () => {
  const render = (model: unknown) =>
    createHttpTransport({
      ...base,
      fetch: stub(() => new Response(renderBody(`0:${JSON.stringify(model)}\n`))),
    }).render("/", {}, new AbortController().signal);
  expect(await render(["a list", "of children"])).toEqual(["a list", "of children"]);
  const error = await rejectionOf(render({ title: "an object" }));
  expect(error).toBeInstanceOf(TransportError);
  expect(messageOf(error)).toBe("Invalid render response");
  // A body without the `{ tree, tags }` envelope is refused the same way.
  const bare = createHttpTransport({
    ...base,
    fetch: stub(() => new Response(`0:${JSON.stringify(["a list"])}\n`)),
  }).render("/", {}, new AbortController().signal);
  expect(messageOf(await rejectionOf(bare))).toBe("Invalid render response");
});

test("a render's tags arrive once its page stream ended", async () => {
  const told: (readonly string[])[] = [];
  const tree = await createHttpTransport({
    ...base,
    fetch: stub(() => new Response(renderBody(`0:"page"\n`, ["notes", "note:1"]))),
  }).render("/", {}, new AbortController().signal, {}, { onTags: (tags) => told.push(tags) });
  expect(tree).toBe("page");
  await Bun.sleep(10);
  expect(told).toEqual([["notes", "note:1"]]);
});
