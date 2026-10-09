---
expect-skill: luciole-app
timeout-minutes: 20
checks:
  - match:
      file: actions/capture.ts
      pattern: ^["']use server["']
  - match:
      file: actions/capture.ts
      pattern: \.(safeParse|parse)\(
  - match:
      file: actions/capture.ts
      pattern: invalidate\(
  - run: bun run verify
  - run: |
      cat > tests/eval-capture.test.ts <<'TEST'
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
      // One word: a field drawn over a border shows its spaces as the border's line.
      const TEXT = "OatMilk42";

      test(
        "/capture keeps unsaved text across a crash, and forgets it once saved",
        async () => {
          await using server = await startServer(app, { NOTES_DB: ":memory:" });
          let session;
          {
            await using first = await openClient(app, server, { tag: "first" });
            await first.waitFor("Welcome to Notes");
            await first.app.router.navigate({ to: "/capture" } as never);
            await first.waitFor("Save");
            await first.type(TEXT);
            await first.waitFor(TEXT);
            session = first.app.restoration.snapshot();
          }
          if (!JSON.stringify(session).includes(TEXT))
            throw new Error(
              `the restored session does not hold the typed text: ${JSON.stringify(session)}`,
            );

          await using second = await openClient(app, server, { tag: "second", session });
          await until(() => second.app.router.state.location.pathname === "/capture");
          await second.waitFor(TEXT);
          await clickLast(second, "Save");
          await act(() => until(() => !JSON.stringify(second.app.restoration.snapshot()).includes(TEXT)));
          // The note reached the Server and the sidebar's list, read again after the change.
          await second.waitFor(TEXT);
          const frame = await second.frame();
          if (!frame.includes(TEXT)) throw new Error(`the new note is not listed:\n${frame}`);
        },
        TEST_TIMEOUT_MS,
      );
      TEST
      bun test tests/eval-capture.test.ts
---

Add a quick-capture page at `/capture`: one single-line text field, focused when the page
opens, and a `Save` button. Save creates a new note whose title and text are both what was
typed (trimmed, at most 120 characters; blank text saves nothing), then empties the field. The
new note shows up in the sidebar's list right away.

Text typed in the field and not yet saved survives a crash of the Client: when the app is
killed with `kill -9` and launched again, `/capture` opens with that text back in the field.
Text that was saved never comes back after a crash. Put the Server Function in
`actions/capture.ts`. Keep `bun run verify` passing.
