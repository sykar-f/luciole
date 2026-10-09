import { expect, test } from "bun:test";
import { messageOf } from "../packages/core/src/guards";
import {
  buildApp,
  eventually,
  openClient,
  startServer,
  TEST_TIMEOUT_MS,
  until,
} from "../packages/core/src/test";
import { rejectionOf } from "./helpers";

// The public testing API, `@luciole-sh/core/test`, on the Notes example.
const app = await buildApp("examples/notes");

test("buildApp builds beside the app, and links the packages it resolves", async () => {
  expect(app.output).toBe(`${app.directory}/.luciole`);
  expect(await Bun.file(`${app.output}/server/index.js`).exists()).toBe(true);
  expect(app.buildId).toMatch(/^[0-9a-f]+$/);
});

test(
  "a Server and a Client are driven by what the screen shows",
  async () => {
    await using server = await startServer(app, { NOTES_DB: ":memory:" });
    await using client = await openClient(app, server, { width: 90, height: 24 });
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
    const first = await client.waitFor("Welcome to Notes");
    expect(first.split("\n")[0]).toHaveLength(90);
    await client.click("Welcome to Notes");
    await client.settled("Getting around");
    await client.press("e", { ctrl: true });
    await client.type("Milk");
    expect(await client.frame()).toContain("Milk");
  },
  TEST_TIMEOUT_MS,
);

test(
  "a wait that never holds fails with what the screen showed, and a click with the screen",
  async () => {
    await using server = await startServer(app, { NOTES_DB: ":memory:" });
    await using client = await openClient(app, server);
    await client.waitFor("Welcome to Notes");
    const waited = await rejectionOf(client.waitFor("Nothing like this", 100));
    expect(messageOf(waited)).toContain("Condition timed out");
    expect(messageOf(waited)).toContain("Welcome to Notes");
    const clicked = await rejectionOf(client.click("Nothing like this"));
    expect(messageOf(clicked)).toContain('"Nothing like this" is not shown');
  },
  TEST_TIMEOUT_MS,
);

test(
  "openClient's network conditions reach the transport: a fault, then a latency",
  async () => {
    await using server = await startServer(app, { NOTES_DB: ":memory:" });
    // Refuses every Server Function call: the page loads, the list of notes cannot.
    await using refused = await openClient(app, server, {
      network: { fault: (request) => (request.kind === "action" ? "refuse" : undefined) },
    });
    await refused.waitFor("Server unreachable");
    const action = refused.requests.finished.find(({ kind }) => kind === "action");
    expect(action).toMatchObject({ type: "error", outcome: "not-sent" });
    // 500 ms of round trip on every request.
    await using slow = await openClient(app, server, { tag: "slow", latencyMs: 500 });
    await slow.waitFor("Welcome to Notes");
    expect(slow.requests.finished[0]).toMatchObject({ type: "end", kind: "render" });
    expect(slow.requests.finished[0]?.ms).toBeGreaterThanOrEqual(480);
  },
  TEST_TIMEOUT_MS,
);

test(
  "stopping twice is harmless, and the Server really exits",
  async () => {
    const server = await startServer(app, { NOTES_DB: ":memory:" });
    const client = await openClient(app, server);
    await client.stop();
    await client.stop();
    await server.stop();
    await server.stop();
    expect(server.child.exitCode !== null || server.child.signalCode !== null).toBe(true);
  },
  TEST_TIMEOUT_MS,
);

test("until and eventually wait on a condition and say what they saw", async () => {
  let count = 0;
  await until(() => ++count > 3, 1000);
  let asked = 0;
  await eventually(async () => ++asked > 3, 1000);
  const refused = await rejectionOf(
    eventually(
      async () => false,
      20,
      () => "the file was missing",
    ),
  );
  expect(messageOf(refused)).toContain("the file was missing");
});
