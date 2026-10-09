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

// A next() already waiting for Flight output must be interruptible: return() on
// Node's async iterator queues behind that next(), unlike stream cancellation.
test(`${name}: cancellation interrupts a pending Flight read`, async () => {
  let signal: AbortSignal | undefined;
  const { errors, stream } = heard(
    page(() => {
      const current = React.cacheSignal();
      if (!(current instanceof AbortSignal)) throw new Error("No Flight cache signal");
      signal = current;
      return React.use(new Promise<never>(() => {}));
    }),
  );
  const reader = stream.getReader();
  await reader.read();
  // Drain the development metadata too: the native adapter preserves chunk
  // boundaries where Node's iterator used to coalesce the first buffered rows.
  let pending = reader.read();
  for (;;) {
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      pending,
      new Promise<null>((done) => {
        quiet = setTimeout(() => done(null), 20);
      }),
    ]);
    clearTimeout(quiet);
    if (result === null) break;
    expect(result.done).toBe(false);
    pending = reader.read();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      reader.cancel(new Error("gone")),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("cancel waits behind next")), 500);
      }),
    ]);
    clearTimeout(timer);
    expect(await pending).toMatchObject({ done: true });
    if (!signal) throw new Error("The page never rendered");
    const active = signal;
    if (!active.aborted) {
      await Promise.race([
        new Promise<void>((done) => active.addEventListener("abort", () => done(), { once: true })),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Flight was not aborted")), 500);
        }),
      ]);
    }
    expect(signal.aborted).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    clearTimeout(timer);
  }
});
