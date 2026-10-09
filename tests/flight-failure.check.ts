import { expect, test } from "bun:test";
import React from "react";
import { notFound } from "../packages/core/src/server";

// Run by tests/instrument.test.ts under the `react-server` condition, like the Server
// itself, once per Flight entry (`FLIGHT_ENTRY`): React allows one RSC renderer per
// process. Each tells the Server of a page's error, not of a not-found nor of a reader
// that leaves, and keeps the digest the Client receives.
const name = process.env.FLIGHT_ENTRY === "web" ? "web" : "node";
const { renderToReadableStream: render } =
  name === "web"
    ? await import("../packages/core/src/web/platform/flight/server")
    : await import("../packages/core/src/flight/server");
const page = (component: () => React.ReactNode) => React.createElement(component);
const heard = (model: unknown) => {
  const errors: unknown[] = [];
  return { errors, stream: render(model, {}, (error) => errors.push(error)) };
};

{
  test(`${name}: a page's error reaches the Server, its digest the Client`, async () => {
    const boom = new TypeError("boom");
    const { errors, stream } = heard(
      page(() => {
        throw boom;
      }),
    );
    const body = await new Response(stream).text();
    expect(errors).toEqual([boom]);
    expect(body).toContain('"digest":"Server render failed"');
  });

  test(`${name}: a not-found is no failure`, async () => {
    const { errors, stream } = heard(page(() => notFound("note")));
    const body = await new Response(stream).text();
    expect(errors).toEqual([]);
    expect(body).toContain("luciole:not-found:");
  });

  test(`${name}: a reader that leaves is no failure`, async () => {
    const { errors, stream } = heard(page(() => React.use(new Promise<never>(() => {}))));
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel(new Error("gone"));
    // Flight reports its abort on the next turns.
    await new Promise((done) => setTimeout(done, 50));
    expect(errors).toEqual([]);
  });
}
