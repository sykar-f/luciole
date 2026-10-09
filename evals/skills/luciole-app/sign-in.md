---
expect-skill: luciole-app
timeout-minutes: 20
checks:
  - exists: server/auth.ts
  - run: grep -rlE "auth *= *[\"']public[\"']" app
  - run: grep -rlE "auth *= *[\"']public[\"']" actions
  - run: bun run verify
  - run: |
      cat > tests/eval-signin.test.ts <<'TEST'
      import { test } from "bun:test";
      import { join } from "node:path";
      import { buildApp, openClient, startServer, TEST_TIMEOUT_MS, until } from "@luciole-sh/core/test";

      const app = await buildApp(join(import.meta.dir, ".."));

      test(
        "the app opens on /login, refuses a wrong PIN and signs ada in",
        async () => {
          await using server = await startServer(app, { NOTES_DB: ":memory:" });
          // The Server itself refuses a request without a session, whatever the Client shows.
          const refused = await fetch(`${server.url}/health`);
          if (refused.status !== 401) throw new Error(`/health answered ${refused.status} without a session`);

          await using client = await openClient(app, server);
          const at = (path: string) => until(() => client.app.router.state.location.pathname === path);
          await at("/login");
          await client.waitFor("Sign in");

          await client.type("ada");
          await client.press("\t");
          await client.type("9999");
          await client.click("Sign in");
          await client.waitFor("Wrong user or PIN");

          for (let i = 0; i < 4; i++) await client.press("\b");
          await client.type("1234");
          await client.click("Sign in");
          await at("/");
          await client.waitFor("No note selected");
        },
        TEST_TIMEOUT_MS,
      );
      TEST
      bun test tests/eval-signin.test.ts
---

Add sign-in to the app. Two accounts exist: `ada` with PIN `1234`, and `alan` with PIN `5678`.
Keep them in a constant on the Server; no hashing is needed for this task.

Every screen and every request to the Server requires a signed-in user, except a sign-in screen
at `/login`. An app opened without a session lands on `/login`. That screen has a user name
field, focused when it opens, a PIN field that Tab moves the focus to, and a `Sign in` button. A
refused sign-in shows `Wrong user or PIN`; a successful one opens `/`. Keep `bun run verify`
passing.
