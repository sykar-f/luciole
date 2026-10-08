import { expect, test } from "bun:test";
import { join } from "node:path";
import { buildApp, openClient, startServer, TEST_TIMEOUT_MS } from "@luciole-sh/core/test";

// Builds the app once, while the file loads, in a temporary directory.
const app = await buildApp(join(import.meta.dir, ".."));

test(
  "a note opens and takes the text typed into it",
  async () => {
    // A Server of its own, on a free port, over a database that dies with it.
    await using server = await startServer(app, { NOTES_DB: ":memory:" });
    // The app's Client, drawn in a test terminal. Stopped before the Server.
    await using client = await openClient(app, server);

    await client.waitFor("Welcome to Notes");
    await client.click("Welcome to Notes");
    await client.waitFor("Getting around");

    await client.press("e", { ctrl: true }); // the cursor to the end of the note
    await client.type("Milk");
    expect(await client.waitFor("Milk")).toContain("Milk");
  },
  TEST_TIMEOUT_MS,
);
