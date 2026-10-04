import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  message,
  parseAddress,
  PLUGIN,
  PROTOCOL_VERSION,
  type Address,
} from "../packages/core/src/devtools/protocol";
import { parseCommand, parseEvent, type DevtoolsEvent } from "../packages/core/src/devtools/schema";
import { connectAgent, listenBus, type Connection } from "../packages/core/src/devtools/wire";
import { messageOf } from "../packages/core/src/guards";
import { rejectionOf, until } from "./helpers";

const hello = { protocol: PROTOCOL_VERSION, role: "client" as const, pid: process.pid };
const request = (callId: string) =>
  message(PLUGIN.client, "request", {
    id: 1,
    callId,
    at: 1,
    kind: "render",
    target: "/",
    type: "request",
    cause: "navigation",
  });

async function roundTrip(address: Address, listenAddress = address) {
  const received: DevtoolsEvent[] = [];
  const commands: unknown[] = [];
  const connections: Connection[] = [];
  // The application starts first: its messages wait for the DevTools.
  const agent = connectAgent({ address, hello, retryMs: 20, onCommand: (c) => commands.push(c) });
  agent.send(request("before"));
  const bus = await listenBus({
    address: listenAddress,
    onOpen: (connection) => connections.push(connection),
    onMessage: (_connection, value) => {
      const event = parseEvent(value);
      if (event) received.push(event);
    },
  });
  try {
    await until(() => received.length === 2);
    agent.send(request("after"));
    await until(() => received.length === 3);
    expect(received.map((e) => e.type)).toEqual([
      "luciole:hello",
      "luciole-client:request",
      "luciole-client:request",
    ]);
    const ids = received.map((e) =>
      e.type === "luciole:hello" ? e.payload.pid : "callId" in e.payload ? e.payload.callId : "",
    );
    expect(ids).toEqual([process.pid, "before", "after"]);
    connections[0]?.send(message(PLUGIN.control, "invalidate", { paths: ["/notes"] }));
    await until(() => commands.length === 1);
    expect(parseCommand(commands[0])).toEqual({
      type: "luciole-devtools:invalidate",
      suffix: "invalidate",
      payload: { paths: ["/notes"] },
    });
  } finally {
    agent.close();
    bus.close();
  }
}

test("an agent buffers until the DevTools listen, then streams and receives commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "luciole-devtools-"));
  try {
    const path = join(dir, "bus.sock");
    await roundTrip({ kind: "unix", path });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the same protocol runs over a WebSocket", async () => {
  // Reserve a free port, then give both sides its address.
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port;
  await probe.stop(true);
  await roundTrip({ kind: "ws", url: `ws://127.0.0.1:${port}` });
});

test("a live DevTools keeps its socket; a dead one's socket is reused, owner-only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "luciole-devtools-"));
  const address: Address = { kind: "unix", path: join(dir, "bus.sock") };
  try {
    const first = await listenBus({ address, onMessage: () => {} });
    expect(messageOf(await rejectionOf(listenBus({ address, onMessage: () => {} })))).toMatch(
      /already listens/,
    );
    expect((await stat(join(dir, "bus.sock"))).mode & 0o777).toBe(0o600);
    first.close();
    // A DevTools that died: killed while it listened, it left its socket and no listener.
    // Its own path: `close()` above unlinks in the background, and on this one could
    // remove the socket the next listener made.
    const dead = join(dir, "dead.sock");
    const killed = Bun.spawn([
      process.execPath,
      "-e",
      `Bun.listen({ unix: ${JSON.stringify(dead)}, socket: { data() {} } }); process.kill(process.pid, "SIGKILL")`,
    ]);
    expect(await killed.exited).not.toBe(0);
    expect((await stat(dead)).isSocket()).toBe(true);
    const second = await listenBus({ address: { kind: "unix", path: dead }, onMessage: () => {} });
    expect((await stat(dead)).mode & 0o777).toBe(0o600);
    second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("addresses and malformed messages", () => {
  expect(parseAddress("1", { XDG_RUNTIME_DIR: "/run/u" }).kind).toBe("unix");
  expect(parseAddress("unix:/tmp/x.sock")).toEqual({ kind: "unix", path: "/tmp/x.sock" });
  expect(parseAddress("ws://127.0.0.1:4206")).toEqual({ kind: "ws", url: "ws://127.0.0.1:4206" });
  expect(() => parseAddress("localhost:1")).toThrow(/LUCIOLE_DEVTOOLS/);
  expect(
    parseEvent({ type: "luciole-client:request", pluginId: "luciole-client", payload: {} }),
  ).toBe(undefined);
  expect(parseEvent({ type: "other:x", pluginId: "other", payload: {} })).toBe(undefined);
  expect(parseEvent("nope")).toBe(undefined);
  // Unknown fields survive: a newer framework's detail still reaches the UI.
  const loader = parseEvent(
    message(PLUGIN.client, "loader", {
      type: "loader",
      at: 1,
      phase: "end",
      routeId: "/",
      href: "/",
      cause: "navigation",
      source: "router-cache",
      extra: 1,
    }),
  );
  expect(loader?.payload).toMatchObject({ source: "router-cache", extra: 1 });
  expect(parseCommand(message(PLUGIN.control, "network", { jitterMs: -1 }))).toBe(undefined);
});
