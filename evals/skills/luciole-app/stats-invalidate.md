---
expect-skill: luciole-app
timeout-minutes: 15
checks:
  - exists: app/stats/page.tsx
  - match:
      file: actions/stats.ts
      pattern: ^["']use server["']
  - no-match:
      file: app/stats/page.tsx
      pattern: ^["']use client["']
  - run: bun run verify
  - run: |
      cat > tests/eval-stats.test.ts <<'TEST'
      import { test } from "bun:test";
      import { join } from "node:path";
      import { buildApp, openClient, startServer, TEST_TIMEOUT_MS, until } from "@luciole-sh/core/test";

      const app = await buildApp(join(import.meta.dir, ".."));

      test(
        "/stats counts the notes, follows a new note and the empty notes' deletion",
        async () => {
          await using server = await startServer(app, { NOTES_DB: ":memory:" });
          await using client = await openClient(app, server);
          await client.waitFor("Welcome to Notes");
          const shown = async () => Number(/Notes: (\d+)/.exec(await client.frame())?.[1] ?? Number.NaN);
          const go = (to: string) => client.app.router.navigate({ to } as never);

          await go("/stats");
          const first = await client.waitFor("Notes: ");
          const before = Number(/Notes: (\d+)/.exec(first)?.[1]);
          if (!Number.isInteger(before)) throw new Error(`no count on /stats:\n${first}`);

          await client.press("n", { ctrl: true });
          await until(() => client.app.router.state.location.pathname.startsWith("/notes/"));
          await go("/stats");
          await client.waitFor(`Notes: ${before + 1}`);

          await client.click("Delete empty notes");
          await client.waitFor(`Notes: ${before}`);
          if ((await shown()) !== before) throw new Error(`count ${await shown()}, expected ${before}`);
        },
        TEST_TIMEOUT_MS,
      );
      TEST
      bun test tests/eval-stats.test.ts
---

Add a statistics page at the route `/stats`. It shows how many notes the user has, as the text
`Notes: <count>`, read on the Server. Below it, a `Delete empty notes` button deletes every note
that has neither a title nor any text.

The count on the page must be right without the user refreshing anything: right after the
button is clicked, and when the user comes back to `/stats` after creating a note from the
sidebar. Put the new Server Function in `actions/stats.ts`. Keep `bun run verify` passing.
