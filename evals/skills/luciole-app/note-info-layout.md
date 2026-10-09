---
expect-skill: luciole-app
timeout-minutes: 15
checks:
  - exists: app/notes/[id]/info/page.tsx
  - run: grep -rlF --include=layout.tsx 'Info view' app
  - match:
      file: app/notes/[id]/info/page.tsx
      pattern: notFound\(
  - run: bun run verify
  - run: |
      cat > tests/eval-info.test.ts <<'TEST'
      import { test } from "bun:test";
      import { act } from "react";
      import { join } from "node:path";
      import {
        buildApp,
        openClient,
        startServer,
        TEST_TIMEOUT_MS,
        until,
        type TestClient,
      } from "@luciole-sh/core/test";

      const app = await buildApp(join(import.meta.dir, ".."));

      /** Clicks the last place `text` is drawn: a button sits below a title that may repeat its words. */
      const clickLast = (client: TestClient, text: string) =>
        act(async () => {
          await client.ui.renderOnce();
          const rows = client.ui.captureCharFrame().split("\n");
          const y = rows.findLastIndex((row) => row.includes(text));
          if (y < 0) throw new Error(`"${text}" is not shown\n${rows.join("\n")}`);
          await client.ui.mockMouse.click(rows[y]?.lastIndexOf(text) ?? 0, y);
        });

      test(
        "a note's tab bar switches between the note and its info",
        async () => {
          await using server = await startServer(app, { NOTES_DB: ":memory:" });
          await using client = await openClient(app, server);
          await client.waitFor("Welcome to Notes");
          const at = (path: string) => until(() => client.app.router.state.location.pathname === path);

          await client.app.router.navigate({ to: "/notes/$id", params: { id: "7" } } as never);
          await client.waitFor("Info view");
          await client.waitFor("Note view");
          await clickLast(client, "Info view");
          await at("/notes/7/info");
          await client.waitFor("Characters: 590");
          await clickLast(client, "Note view");
          await at("/notes/7");
          await client.waitFor("Info view");

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

Both `/notes/<id>` and `/notes/<id>/info` show the same bar above the page, with two buttons
labelled `Note view` and `Info view`: each opens that screen of the same note. The bar stays
mounted while the user switches between the two screens of a note. For a note that does not
exist, `/notes/<id>/info` shows the same screen as `/notes/<id>` does. Keep `bun run verify`
passing.
