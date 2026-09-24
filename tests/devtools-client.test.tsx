/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoute } from "@tanstack/react-router";
import { createTestRenderer } from "@opentui/core/testing";
import { createApplication } from "../src/client";
import { startClientAgent } from "../src/devtools/client-agent";
import { message, PLUGIN } from "../src/devtools/protocol";
import { parseEvent, type DevtoolsEvent } from "../src/devtools/schema";
import { listenBus, type Connection } from "../src/devtools/wire";
import { loadPage, pageRoute, rootRoute } from "../src/route-tree";
import type { Fetch } from "../src/transport";
import { present, until } from "./helpers";

// Answers every render with a string, as the Server's root Flight row.
const fetchPage: Fetch = (url) =>
  Promise.resolve(new Response(`0:${JSON.stringify(`page ${url.searchParams.get("route")}`)}\n`));

test("the Client agent streams events and router state, and obeys commands", async () => {
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
  const agent = present(startClientAgent({ address: `unix:${path}`, name: "test" }), "agent");
  const root = rootRoute(({ children }) => children);
  const page = (path: string) =>
    createRoute({
      getParentRoute: () => root,
      path,
      loader: (ctx) => loadPage(ctx, path, []),
      ...pageRoute([]),
    });
  const network = {};
  const app = createApplication({
    url: "http://terminal.invalid",
    buildId: "build-1",
    resolveModule: (id) => {
      throw new Error(`Unknown Client module: ${id}`);
    },
    routeTree: root.addChildren([page("/"), page("/b")]),
    fetch: fetchPage,
    network,
    wrapTransport: agent.wrapTransport,
  });
  const { renderer } = await createTestRenderer({ width: 20, height: 4 });
  agent.attach(app, renderer);
  const of = <T extends DevtoolsEvent["type"]>(type: T) =>
    received.filter((e): e is Extract<DevtoolsEvent, { type: T }> => e.type === type);
  try {
    await app.router.load();
    await app.router.preloadRoute({ to: "/b" });
    await app.router.navigate({ to: "/b" });
    await until(() => of("airtty-client:loader").some((e) => e.payload.synthetic));
    // TanStack served the preloaded /b: no request, a "(memory cache)" row instead.
    expect(of("airtty-client:loader").find((e) => e.payload.synthetic)?.payload).toMatchObject({
      routeId: "/b",
      source: "router-cache",
      cause: "preload",
    });
    expect(of("airtty:hello")[0]?.payload).toMatchObject({ role: "client", app: "test" });
    expect(of("airtty-components:unavailable")).toHaveLength(1);
    await until(() => of("airtty-router:state").some((e) => e.payload.href === "/b"));

    console.warn("from the Client", { n: 1 });
    await until(() => of("airtty-console:entry").length > 0);
    expect(of("airtty-console:entry").at(-1)?.payload).toMatchObject({
      level: "warn",
      text: "from the Client { n: 1 }",
    });

    // Live network conditions: latency before sending, faults on the transport itself.
    const connection = present(connections[0], "connection");
    connection.send(
      message(PLUGIN.control, "network", {
        latencyMs: 60,
        jitterMs: 5,
        faults: [{ type: "refuse", p: 0 }],
      }),
    );
    await until(() => "jitterMs" in network);
    expect(network).toMatchObject({ jitterMs: 5 });
    connection.send(message(PLUGIN.control, "invalidate", { paths: ["/b"] }));
    await until(() => of("airtty-client:request").some((e) => e.payload.cause === "invalidation"));
    const start = of("airtty-client:loader").findLast(
      (e) => e.payload.phase === "start" && e.payload.cause === "invalidation",
    );
    const sent = of("airtty-client:request").findLast((e) => e.payload.cause === "invalidation");
    expect((sent?.payload.at ?? 0) - (start?.payload.at ?? 0)).toBeGreaterThanOrEqual(55);
  } finally {
    renderer.destroy();
    bus.close();
    await rm(dir, { recursive: true, force: true });
  }
});
