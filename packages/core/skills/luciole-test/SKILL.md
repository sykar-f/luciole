---
name: luciole-test
description: Tests of a luciole app. Read before writing, changing, running or fixing any `bun test` file of an app built on `@luciole-sh/core` (`tests/*.test.ts`, `buildApp`, `startServer`, `openClient`), including a test of a Server Function or of `server/` code; testing what the user sees after a failed save, an unreachable Server, latency or a fault; testing that typed text comes back after a restart; or when a luciole test times out, cannot import the code it tests, or passes when it should fail. Also for "add tests", "write a test for this screen", "test the error message", "prove it with a test", "why does my test hang".
---

# Testing a luciole app

A test builds the app, starts its Server in a process of its own, and draws its Client in a
test terminal inside `bun test`. The docs of the installed version:
`node_modules/@luciole-sh/core/docs/guides/testing.md` (the levels and the API) and
`node_modules/@luciole-sh/core/docs/reference/api.md` (every export of `@luciole-sh/core/test`).
Feature code is the `luciole-app` skill's.

## The shape of a test file

```ts
import { expect, test } from "bun:test";
import { join } from "node:path";
import { buildApp, openClient, startServer, TEST_TIMEOUT_MS } from "@luciole-sh/core/test";

// Once per file, at the top level: a fresh build from the sources, outside every timeout.
const app = await buildApp(join(import.meta.dir, ".."));

test(
  "a note opens and takes the text typed into it",
  async () => {
    // The Server's own process environment: the app's settings and a database per test.
    await using server = await startServer(app, { NOTES_DB: ":memory:" });
    // Declared after the Server, so it stops first.
    await using client = await openClient(app, server);

    await client.waitFor("Welcome to Notes");
    await client.click("Welcome to Notes");
    await client.waitFor("Getting around");
    await client.press("e", { ctrl: true });
    await client.type("Milk");
    expect(await client.waitFor("Milk")).toContain("Milk");
  },
  TEST_TIMEOUT_MS,
);
```

## Gotchas

- Test Server Functions, pages and the code under `server/` through the built app: drive the
  screen that calls them, and check what it shows. They run only inside the built Server,
  within a request: imported into a test, they fail on `Cannot find package 'server-only'`, then
  on React's `react-server` condition.
- Set latency and faults on the Client: `openClient(app, server, { latencyMs, network })`. The
  Server ignores `LUCIOLE_LATENCY_MS`, `LUCIOLE_FAULT` and the other network variables passed to
  `startServer`. Read [references/network.md](references/network.md), beside this `SKILL.md`,
  when a test needs a failed request, a fault or latency.
- Put the settings the app reads with `process.env` in its pages, layouts, Server Functions or
  `server/` into `startServer`'s second argument: they run in the Server's process. A setting the
  Notes starter reads that way is `NOTES_AUTOSAVE_MS` (`"0"` turns autosave off).
- Wait on the screen. `client.waitFor(text)` waits for a text to appear; `eventually(async () =>
!(await client.frame()).includes(text))` waits for one to go; `client.settled(text)` also waits
  for highlighting and images to finish. The app's own timers (an autosave, a retry, a message shown
  after 3 s) run in real time during these waits, which last up to 30 s.
- Run every test file you write or change with `bun test <file>` and see it pass: a starter's `bun
run verify` builds the app but runs no test.
- Pass `TEST_TIMEOUT_MS` as the last argument of every `test()` that opens a Client.
- Keep a single copy of `react` in `node_modules` (`bun pm ls --all | grep ' react@'` lists one):
  the test renders the built Client with the test's own React, and a second copy fails with "Invalid
  hook call".
- `buildApp` rebuilds from the sources at every `bun test`. When the file fails before any test
  runs, `bun run verify` names the build error's file and line.
- Read [references/restore.md](references/restore.md), beside this `SKILL.md`, when a test restarts
  the app or checks what comes back after a crash.

## What else proves an app

- `bun run verify`: types, lint, format and the build, which refuses code on the wrong side of
  the Client/Server boundary. Run it after every change, tests included.
- Real-terminal journeys (`scripts/pty/`) exist only inside the luciole repository; an app
  cannot import their driver. Drive the app in-process instead.
