/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { createRootRoute } from "@tanstack/react-router";
import {
  createApplication,
  TransportError,
  type ApplicationOptions,
  type Transport,
} from "../packages/core/src/client";
import type { Fetch } from "../packages/core/src/transport";
import { rejectionOf } from "./helpers";

const base = {
  url: "http://terminal.invalid",
  buildId: "build-1",
  resolveModule: (id: string) => {
    throw new Error(`Unknown Client module: ${id}`);
  },
  routeTree: createRootRoute(),
} satisfies ApplicationOptions;
const load = () => ({ signal: new AbortController().signal, href: "/", route: "/" });

/** A decorator in its own module would look like this: it records, then forwards. */
function recording(seen: string[]) {
  return (inner: Transport): Transport => ({
    render(routeId, ...rest) {
      seen.push(`render ${routeId}`);
      return inner.render(routeId, ...rest);
    },
    call(actionId, ...rest) {
      seen.push(`call ${actionId}`);
      return inner.call(actionId, ...rest);
    },
    setToken: (token) => inner.setToken(token),
  });
}

test("a decorator sees every render and call of the transport it wraps", async () => {
  const seen: string[] = [];
  const inner: Transport = {
    render: async (routeId) => <text>PAGE {routeId}</text>,
    call: async (actionId, args) => ({ actionId, args }),
    setToken: (token) => seen.push(`token ${token}`),
  };
  const app = createApplication({ ...base, transport: inner, wrapTransport: recording(seen) });
  expect(await app.renderPage("/notes/[id]", { id: "1" }, load())).toBeTruthy();
  expect(await app.callServer("save", [1])).toEqual({ actionId: "save", args: [1] });
  app.setToken("t");
  expect(seen).toEqual(["render /notes/[id]", "call save", "token t"]);
});

test("the HTTP transport's failures cross a decorator with their outcome", async () => {
  const seen: string[] = [];
  const fetch: Fetch = (url) =>
    url.pathname === "/render"
      ? Promise.resolve(new Response("Route not found", { status: 404 }))
      : Promise.reject(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
  const app = createApplication({ ...base, fetch, wrapTransport: recording(seen) });
  const render = await rejectionOf(app.renderPage("/missing", {}, load()));
  const call = await rejectionOf(app.callServer("save", []));
  expect(seen).toEqual(["render /missing", "call save"]);
  expect(render).toBeInstanceOf(TransportError);
  expect(render instanceof TransportError && render.outcome).toBe("rejected");
  expect(call).toBeInstanceOf(TransportError);
  expect(call instanceof TransportError && call.outcome).toBe("not-sent");
});
