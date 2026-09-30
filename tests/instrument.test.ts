import { expect, test } from "bun:test";
import { createInterface } from "node:readline";
import { z } from "zod";
import {
  createHttpTransport,
  TransportError,
  type TransportEvent,
} from "../packages/luciole/src/transport";
import { launch, rejectionOf, until } from "./helpers";

// What tests/instrument-server.ts prints for each ServerEvent (src/server.ts).
const Printed = z.object({
  event: z.object({
    callId: z.string(),
    at: z.number(),
    kind: z.enum(["render", "action"]),
    target: z.string(),
    type: z.enum(["request", "response", "end", "error"]),
    status: z.number().optional(),
    ms: z.number().optional(),
  }),
});
type Event = z.infer<typeof Printed>["event"];

test("the Server reports each render and action under the Client's callId", async () => {
  const server = await launch("tests/instrument-server.ts");
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
    // Both processes share the epoch clock: the Server sees a request after it is sent.
    for (const event of received) {
      const sent = client.find((e) => e.callId === event.callId && e.type === "request");
      expect(event.at).toBeGreaterThanOrEqual((sent?.at ?? Infinity) - 5);
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
