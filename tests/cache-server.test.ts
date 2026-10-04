import { expect, test } from "bun:test";
import { createInterface } from "node:readline";
import { z } from "zod";
import {
  createHttpTransport,
  TransportError,
  type TransportEvent,
} from "../packages/core/src/transport";
import { launch, rejectionOf, until, WAIT_MS } from "./helpers";

// The cache's ServerEvent (src/cache/runtime.ts), as tests/cache-server.ts prints it.
const Printed = z.object({
  event: z.object({
    type: z.literal("cache"),
    op: z.enum(["hit", "miss", "stale", "write", "invalidate"]),
    key: z.string(),
    fn: z.string(),
    tags: z.array(z.string()),
    callId: z.string(),
    ms: z.number(),
    at: z.number(),
  }),
});
type Event = z.infer<typeof Printed>["event"];

test("the Server reports cache operations, sends a render's tags and an action's", async () => {
  const server = await launch("tests/cache-server.ts");
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
  const tags: (readonly string[])[] = [];
  const invalidated: [string[], string[]][] = [];
  const transport = createHttpTransport({
    url: server.url,
    buildId: "build-1",
    callServer: () => Promise.reject(new Error("unused")),
    onEvent: (event) => client.push(event),
    onInvalidate: (paths, invalidatedTags) => invalidated.push([paths, invalidatedTags]),
  });
  const render = () =>
    transport.render("/", {}, new AbortController().signal, {}, { onTags: (t) => tags.push(t) });
  try {
    await render();
    await render();
    expect(await transport.call("a.ts#bump", [])).toBe("bumped");
    await render();
    const failure = await rejectionOf(transport.call("a.ts#bad", []));
    expect(failure instanceof TransportError && failure.outcome).toBe("unknown");
    await until(() => received.filter((e) => e.op === "write").length === 2);
    await until(() => tags.length === 3);
    expect(tags).toEqual([["count"], ["count"], ["count"]]);
    expect(invalidated).toEqual([[["/"], ["count"]]]);
    const calls = client.flatMap((e) => (e.type === "request" ? [e.callId] : []));
    expect(received.map((e) => [e.op, e.fn, e.tags, e.callId])).toEqual([
      ["write", "server/count.ts#count", ["count"], calls[0]],
      ["miss", "server/count.ts#count", ["count"], calls[0]],
      ["hit", "server/count.ts#count", ["count"], calls[1]],
      ["invalidate", "", ["count"], calls[2]],
      ["write", "server/count.ts#count", ["count"], calls[3]],
      ["miss", "server/count.ts#count", ["count"], calls[3]],
    ]);
    expect(new Set(received.filter((e) => e.fn).map((e) => e.key)).size).toBe(1);
  } finally {
    await server.stop();
  }
});

test("a read below Suspense sends its tag at the page's end, without delaying the shell", async () => {
  const server = await launch("tests/cache-server.ts");
  const events: TransportEvent[] = [];
  const transport = createHttpTransport({
    url: server.url,
    buildId: "build-1",
    callServer: () => Promise.reject(new Error("unused")),
    onEvent: (event) => events.push(event),
  });
  const open = (route: string) => transport.render(route, {}, new AbortController().signal, {}, {});
  try {
    let told: readonly string[] | undefined;
    // The Server holds the page function and Late behind gates (tests/cache-server.ts): what
    // the test sees is the order in which things happen, whatever the speed of the machine.
    const rendering = transport.render(
      "/late",
      {},
      new AbortController().signal,
      {},
      {
        onTags: (tags) => (told = tags),
      },
    );
    // Headers leave while the page function has not returned: its gate is still closed, and
    // /late is the only request so far.
    await until(() => events.some((e) => e.type === "response"), WAIT_MS);
    // The page function returns; the shell follows it while Late is still held.
    await open("/open-page");
    const tree = await rendering;
    expect(tree).toBeTruthy();
    expect(told).toBeUndefined();
    // Late returns: its tag reaches the Client at the end of the page.
    await open("/open-late");
    await until(() => told !== undefined, WAIT_MS);
    expect(told).toEqual(["late"]);
  } finally {
    await server.stop();
  }
});
