import { expect, test } from "bun:test";
import { relayBody } from "../packages/core/src/cache/render";
import { createInterface } from "node:readline";
import { z } from "zod";
import {
  createHttpTransport,
  TransportError,
  type TransportEvent,
} from "../packages/core/src/transport";
import { eventually, launch, rejectionOf, until } from "./helpers";

// What tests/instrument-server.ts prints for each ServerEvent (src/server.ts).
const Printed = z.object({
  event: z.object({
    callId: z.string(),
    at: z.number(),
    kind: z.enum(["render", "action"]),
    target: z.string(),
    type: z.enum(["request", "response", "end", "error", "failure"]),
    status: z.number().optional(),
    ms: z.number().optional(),
    message: z.string().optional(),
    cancelled: z.boolean().optional(),
  }),
});
type Event = z.infer<typeof Printed>["event"];
/** The events the Server at `server` prints, as they arrive. */
function printedEvents(server: Awaited<ReturnType<typeof launch>>) {
  const received: Event[] = [];
  createInterface({ input: server.child.stdout }).on("line", (line) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    const printed = Printed.safeParse(value);
    if (printed.success) received.push(printed.data.event);
  });
  return received;
}

test("the Server reports each render and action under the Client's callId", async () => {
  const beforeLaunch = Date.now();
  const server = await launch("tests/instrument-server.ts");
  const received = printedEvents(server);
  const client: TransportEvent[] = [];
  const transport = createHttpTransport({
    url: server.url,
    buildId: "build-1",
    callServer: () => Promise.reject(new Error("unused")),
    onEvent: (event) => client.push(event),
  });
  try {
    await transport.render("/", {}, new AbortController().signal);
    expect(await transport.call("a.ts#run", [])).toBe(42);
    const failure = await rejectionOf(transport.call("a.ts#boom", []));
    expect(failure instanceof TransportError && failure.outcome).toBe("unknown");
    await until(() => received.filter((e) => e.type === "end" || e.type === "error").length === 3);
    const afterEvents = Date.now();
    const calls = client.flatMap((e) => (e.type === "request" ? [e.callId] : []));
    expect(received.map((e) => [e.callId, e.kind, e.target, e.type, e.status])).toEqual([
      [calls[0], "render", "/", "request", undefined],
      [calls[0], "render", "/", "response", 200],
      [calls[0], "render", "/", "end", undefined],
      [calls[1], "action", "a.ts#run", "request", undefined],
      [calls[1], "action", "a.ts#run", "response", 200],
      [calls[1], "action", "a.ts#run", "end", undefined],
      [calls[2], "action", "a.ts#boom", "request", undefined],
      [calls[2], "action", "a.ts#boom", "error", undefined],
    ]);
    // Allow for process clock offsets when checking that timestamps use epoch milliseconds.
    const previousAt = new Map<string, number>();
    for (const event of received) {
      expect(event.at).toBeGreaterThanOrEqual(beforeLaunch - 1_000);
      expect(event.at).toBeLessThanOrEqual(afterEvents + 1_000);
      const previous = previousAt.get(event.callId);
      if (previous !== undefined) expect(event.at).toBeGreaterThanOrEqual(previous);
      previousAt.set(event.callId, event.at);
    }
    const action = await fetch(`${server.url}/action`, {
      method: "POST",
      headers: { "x-luciole-build": "build-1", "x-luciole-action": "a.ts#run" },
      body: "[]",
    });
    await action.text();
    expect(action.headers.get("server-timing")).toMatch(/^total;dur=\d+(\.\d)?$/);
  } finally {
    await server.stop();
  }
});

// Production Flight hands the Client a digest and drops the message: the Server's log keeps
// the error's name, its instrument the message. A not-found, or a Client that leaves, is no
// failure.
test("a page that throws is logged by name and reported with its message", async () => {
  const server = await launch("tests/instrument-server.ts", { NODE_ENV: "production" });
  const received = printedEvents(server);
  let log = "";
  server.child.stderr.on("data", (s: Buffer) => (log += s.toString()));
  const render = (route: string, callId: string, signal?: AbortSignal) =>
    fetch(`${server.url}/render?route=${encodeURIComponent(route)}`, {
      headers: { "x-luciole-build": "build-1", "x-luciole-call": callId },
      signal,
    });
  try {
    const broken = await (await render("/broken", "call-broken")).text();
    const missing = await (await render("/missing", "call-missing")).text();
    const leaving = new AbortController();
    const pending = await render("/pending", "call-pending", leaving.signal);
    await pending.body?.getReader().read();
    leaving.abort();
    const of = (callId: string) => received.filter((e) => e.callId === callId);
    await until(
      () =>
        of("call-broken").some((e) => e.type === "end") &&
        of("call-missing").some((e) => e.type === "end") &&
        of("call-pending").some((e) => e.cancelled === true),
    );
    // The Server aborts the page once the Client left: a later request shows it done.
    await (await render("/", "call-after")).text();
    await until(() => of("call-after").some((e) => e.type === "end"));
    expect(broken).toContain('E{"digest":"Server render failed"}');
    expect(missing).toContain('E{"digest":"luciole:not-found:\\"note\\""}');
    expect(broken + log).not.toContain("boom");
    expect(log.split("\n").filter((line) => line.includes("failed"))).toEqual([
      "Render failed call-broken /broken TypeError",
    ]);
    // `failure` comes wherever Flight raised it: the rest of the sequence stays the same.
    const failures = of("call-broken").filter((e) => e.type === "failure");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ kind: "render", target: "/broken", message: "boom" });
    expect(
      of("call-broken")
        .map((e) => e.type)
        .filter((type) => type !== "failure"),
    ).toEqual(["request", "response", "end"]);
    expect(of("call-missing").map((e) => e.type)).toEqual(["request", "response", "end"]);
    expect(of("call-pending").filter((e) => e.type === "failure")).toEqual([]);
  } finally {
    await server.stop();
  }
});

// The cache signal belongs to the inner Flight render, so this checks the entire
// HTTP body -> outer Flight -> serialized page stream -> inner Flight chain.
for (const entry of ["node", "web"]) {
  for (const proof of ["terminal event", "Flight abort"]) {
    test(`${entry}: a Client abort has one ${proof} on the Server path`, async () => {
      const server = await launch("tests/instrument-server.ts", { FLIGHT_ENTRY: entry });
      const received = printedEvents(server);
      const transport = createHttpTransport({
        url: server.url,
        buildId: "build-1",
        callServer: () => Promise.reject("unused"),
      });
      try {
        expect(await transport.call("a.ts#entry", [])).toBe(entry);
        const leaving = new AbortController();
        const response = await fetch(`${server.url}/render?route=/pending`, {
          headers: {
            "x-luciole-build": "build-1",
            "x-luciole-call": "leaving",
            connection: "close",
          },
          signal: leaving.signal,
        });
        await response.body?.getReader().read();
        expect(await transport.call("a.ts#pending-state", [])).toEqual([false]);
        leaving.abort();
        await until(() => received.some((e) => e.callId === "leaving" && e.cancelled));
        if (proof === "Flight abort") {
          await eventually(async () => {
            const state = await transport.call("a.ts#pending-state", []);
            return JSON.stringify(state) === "[true]";
          }, 2_000);
        } else {
          // A second request gives the cancelled reads time to settle in the Server.
          await transport.call("a.ts#run", []);
          const terminal = received.filter(
            (e) => e.callId === "leaving" && (e.type === "end" || e.type === "error"),
          );
          expect(terminal).toHaveLength(1);
          expect(terminal[0]).toMatchObject({ type: "end", cancelled: true });
        }
        expect(received.filter((e) => e.callId === "leaving" && e.type === "failure")).toEqual([]);
      } finally {
        await server.stop();
      }
    });
  }
}

// Flight runs where the Server runs, under the `react-server` condition, which this
// `bun test` process does not use: tests/flight-failure.check.ts holds the cases.
for (const entry of ["node", "web"])
  test(`the ${entry} Flight entry reports a page's errors (tests/flight-failure.check.ts)`, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "test",
        "--conditions=react-server",
        "--timeout",
        "20000",
        "./tests/flight-failure.check.ts",
      ],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, FLIGHT_ENTRY: entry } },
    );
    const [code, output] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code !== 0) console.error(output);
    expect(code).toBe(0);
  });

// Exercise the relay's completion owner with a controlled source, including the
// pending read that cancellation resolves to done in the original reader wrapper.
for (const outcome of ["normal", "error", "cancel"] as const) {
  test(`the body relay settles once on ${outcome}`, async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const cancelled: unknown[] = [];
    const events: unknown[] = [];
    const bytes: number[] = [];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
      },
      cancel(reason) {
        cancelled.push(reason);
      },
    });
    const reader = relayBody(body, {
      chunk: (value) => bytes.push(...value),
      end: (event) => events.push(event),
    }).getReader();
    const first = reader.read();
    source.enqueue(new Uint8Array([1, 2, 3]));
    expect((await first).value).toEqual(new Uint8Array([1, 2, 3]));
    const pending = reader.read();
    const reason = new Error("gone");
    if (outcome === "cancel") {
      await reader.cancel(reason);
      expect(await pending).toMatchObject({ done: true });
      expect(cancelled).toEqual([reason]);
      expect(events).toEqual([{ type: "end", cancelled: true }]);
    } else if (outcome === "error") {
      source.error(reason);
      expect(await rejectionOf(pending)).toBe(reason);
      expect(events).toEqual([{ type: "error", error: reason }]);
    } else {
      source.close();
      expect(await pending).toMatchObject({ done: true });
      await until(() => events.length > 0);
      expect(events).toEqual([{ type: "end", cancelled: false }]);
    }
    expect(bytes).toEqual([1, 2, 3]);
  });
}

test("the body relay keeps an unread source under backpressure", async () => {
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array([pulls]));
    },
  });
  const relayed = relayBody(body);
  await new Promise((done) => setTimeout(done, 20));
  expect(pulls).toBeLessThanOrEqual(3);
  await relayed.cancel();
});
