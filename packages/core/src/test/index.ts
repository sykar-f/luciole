/**
 * Test a luciole app end to end, from a `bun test` file: build it, start its Server, render
 * its Client in a test terminal, wait for a frame, press keys and click.
 *
 * ```tsx
 * const app = await buildApp();
 * test("opens a note", async () => {
 *   await using server = await startServer(app);
 *   await using client = await openClient(app, server);
 *   await client.waitFor("Welcome to Notes");
 *   await client.click("Welcome to Notes");
 * }, TEST_TIMEOUT_MS);
 * ```
 */
export { buildApp, type BuiltApp } from "./build";
export { startServer, type TestServer } from "./server";
export {
  openClient,
  type ClientOptions,
  type KeyModifiers,
  type OpenClientOptions,
  type TestClient,
} from "./client";
export { eventually, TEST_TIMEOUT_MS, until, WAIT_MS, type TestUI } from "./wait";
