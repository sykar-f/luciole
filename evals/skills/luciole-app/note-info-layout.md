---
expect-skill: luciole-app
timeout-minutes: 15
checks:
  - exists: app/notes/[id]/info/page.tsx
  - run: grep -rlF --include=layout.tsx '[Info]' app
  - match:
      file: app/notes/[id]/info/page.tsx
      pattern: notFound\(
  - run: bun run verify
  - run: |
      cat > tests/eval-info.test.ts <<'TEST'
      import { test } from "bun:test";
      import { join } from "node:path";
      import { buildApp, openClient, startServer, TEST_TIMEOUT_MS, until } from "@luciole-sh/core/test";

      const app = await buildApp(join(import.meta.dir, ".."));

      test(
        "a note's tab bar switches between the note and its info",
        async () => {
          await using server = await startServer(app, { NOTES_DB: ":memory:" });
          await using client = await openClient(app, server);
          await client.waitFor("Welcome to Notes");
          const at = (path: string) => until(() => client.app.router.state.location.pathname === path);

          await client.app.router.navigate({ to: "/notes/$id", params: { id: "7" } } as never);
          await client.waitFor("[Info]");
          await client.waitFor("[Note]");
          await client.click("[Info]");
          await at("/notes/7/info");
          await client.waitFor("Characters: 590");
          await client.click("[Note]");
          await at("/notes/7");
          await client.waitFor("[Info]");

          await client.app.router.navigate({ to: "/notes/$id/info", params: { id: "nope" } } as never);
          await client.waitFor("No note selected");
        },
        TEST_TIMEOUT_MS,
      );
      TEST
      bun test tests/eval-info.test.ts
---

Give every note a second screen at `/notes/<id>/info` that shows how many characters the note's
Markdown text holds, as `Characters: <count>` (the stored text's JavaScript `length`).

Both `/notes/<id>` and `/notes/<id>/info` show the same bar above the page, with two buttons,
`[Note]` and `[Info]`: each opens that screen of the same note. The bar stays mounted while the
user switches between the two screens of a note. For a note that does not exist,
`/notes/<id>/info` shows the same screen as `/notes/<id>` does. Keep `bun run verify` passing.
