import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEvent, type DevtoolsEvent } from "../packages/airtty/src/devtools/schema";
import { devtoolsInstrument } from "../packages/airtty/src/devtools/server-agent";
import { message, PLUGIN } from "../packages/airtty/src/devtools/protocol";
import { listenBus, type Connection } from "../packages/airtty/src/devtools/wire";
import { createHttpTransport, type TransportEvent } from "../packages/airtty/src/transport";
import { launch, until } from "./helpers";

test("AIRTTY_DEVTOOLS streams the Server's events and logs under the Client's callId", async () => {
  const dir = await mkdtemp(join(tmpdir(), "airtty-devtools-"));
  const path = join(dir, "bus.sock");
  const received: DevtoolsEvent[] = [];
  const bus = await listenBus({
    address: { kind: "unix", path },
    onMessage: (_c, value) => {
      const event = parseEvent(value);
      if (event) received.push(event);
    },
  });
  const server = await launch("tests/devtools-server.ts", { AIRTTY_DEVTOOLS: `unix:${path}` });
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
    await until(() => received.filter((e) => e.type === "airtty-server:end").length === 2);
    const [render, action] = client.flatMap((e) => (e.type === "request" ? [e.callId] : []));
    const hello = received.find((e) => e.type === "airtty:hello");
    expect(hello?.payload).toMatchObject({ role: "server", buildId: "build-1" });
    const server = received.flatMap((e) =>
      e.pluginId === "airtty-server" && "callId" in e.payload
        ? [[e.payload.callId, e.payload.type]]
        : [],
    );
    expect(server).toEqual([
      [render, "request"],
      [render, "response"],
      [render, "end"],
      [action, "request"],
      [action, "response"],
      [action, "end"],
    ]);
    const logs = received.flatMap((e) =>
      e.type === "airtty-console:entry"
        ? [[e.payload.level, e.payload.text, e.payload.callId]]
        : [],
    );
    expect(logs).toContainEqual(["log", "rendering home", render]);
    expect(logs).toContainEqual(["warn", "running { n: 1 }", action]);
  } finally {
    await server.stop();
    bus.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("cache events reach the DevTools and the configured instrument alike", async () => {
  const dir = await mkdtemp(join(tmpdir(), "airtty-devtools-"));
  const path = join(dir, "bus.sock");
  const received: DevtoolsEvent[] = [];
  const bus = await listenBus({
    address: { kind: "unix", path },
    onMessage: (_c, value) => {
      const event = parseEvent(value);
      if (event) received.push(event);
    },
  });
  const configured: unknown[] = [];
  const instrument = devtoolsInstrument({ onEvent: (e) => configured.push(e) }, `unix:${path}`, {
    buildId: "build-1",
    getCallId: () => undefined,
    invalidateTag: () => Promise.resolve(),
  });
  const cache = {
    type: "cache" as const,
    op: "hit" as const,
    key: "k",
    fn: "notes#get",
    tags: ["notes"],
    callId: "c1",
    ms: 1,
    at: Date.now(),
  };
  try {
    instrument?.onEvent(cache);
    await until(() => received.some((e) => e.type === "airtty-server:cache"));
    expect(received.find((e) => e.type === "airtty-server:cache")?.payload).toMatchObject(cache);
    expect(configured).toEqual([cache]);
  } finally {
    bus.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the Cache panel's command purges a tag on the Server, outside any request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "airtty-devtools-"));
  const path = join(dir, "bus.sock");
  const received: DevtoolsEvent[] = [];
  const connections: Connection[] = [];
  const bus = await listenBus({
    address: { kind: "unix", path },
    onOpen: (connection) => connections.push(connection),
    onMessage: (_c, value) => {
      const event = parseEvent(value);
      if (event) received.push(event);
    },
  });
  const server = await launch("tests/devtools-server.ts", { AIRTTY_DEVTOOLS: `unix:${path}` });
  try {
    await until(() => received.some((e) => e.type === "airtty:hello"));
    connections[0]?.send(message(PLUGIN.control, "cache-invalidate", { tag: "notes" }));
    await until(() => received.some((e) => e.type === "airtty-server:cache"));
    // No request: the Server cache only, no Client told (callId "").
    expect(received.find((e) => e.type === "airtty-server:cache")?.payload).toMatchObject({
      op: "invalidate",
      tags: ["notes"],
      callId: "",
    });
  } finally {
    await server.stop();
    bus.close();
    await rm(dir, { recursive: true, force: true });
  }
});
