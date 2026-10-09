---
expect-skill: luciole-app
timeout-minutes: 8
setup: |
  cat > app/layout.tsx <<'LAYOUT'
  "use client";
  import type { LayoutProps } from "@luciole-sh/core/client";
  export default function Layout({ children }: LayoutProps) {
    return <box flexDirection="column" flexGrow={1}>{children}</box>;
  }
  LAYOUT
  bunx oxfmt --write app/layout.tsx
checks:
  - run: |
      for hook in useMatchRoute useCanGoBack useRouter useRouterState useNavigate; do
        grep -qE "\b${hook}\s*\(" components/RouteTools.tsx || exit 1
      done
      ! grep -qE 'as never|as any|<Link\b|createFileRoute|createRoute' components/RouteTools.tsx
  - run: bun run verify
  - run: |
      mkdir -p tests
      trap 'rm -f tests/library-eval.test.ts' EXIT
      cat > tests/library-eval.test.ts <<'TEST'
      import { expect, test } from "bun:test";
      import { act } from "react";
      import { buildApp, startServer, openClient, until, TEST_TIMEOUT_MS } from "@luciole-sh/core/test";
      const app = await buildApp();
      function nodes(node) { return [node, ...node.getChildren().flatMap(nodes)]; }
      function native(client, name) {
        const found = nodes(client.ui.renderer.root).filter(n => n.constructor.name.includes(name) && n.visible && n.width > 0 && n.height > 0 && n.screenX >= 0 && n.screenX < client.ui.renderer.width && n.screenY >= 0 && n.screenY < client.ui.renderer.height);
        expect(found).toHaveLength(1);
        for (let n = found[0]; n; n = n.parent) expect(n.visible).toBe(true);
        return found[0];
      }
      test("header matches descendants, preserves string search, guards back and preloads once", async () => {
        await using server = await startServer(app, { NOTES_DB: ":memory:" });
        // Hold a real render response until the pending frame has been observed, not a timing gate.
        let release;
        let holding = false;
        const fetcher = async (url, init) => {
          if (holding && url.pathname === "/render") await new Promise(done => { release = done; });
          return fetch(url, init);
        };
        await using c = await openClient(app, server, { fetch: fetcher });
        await c.waitFor("Help inactive");
        await c.press("left", { meta: true });
        await c.waitFor("Back unavailable");
        expect(c.app.router.state.location.pathname).toBe("/");
        const renders = [];
        c.app.onEvent(e => { if (e.type === "request" && e.kind === "render") renders.push(e); });
        await c.press("p", { ctrl: true });
        await act(() => until(() => renders.length > 0));
        await act(() => c.requests.settled());
        expect(renders).toHaveLength(1);
        expect(renders[0].cause).toBe("preload");
        expect(c.app.router.state.location.pathname).toBe("/");
        c.ui.renderer.useKittyKeyboard = true;
      await act(async () => c.ui.mockInput.pressKey("\x1b[104;5u"));
        await c.waitFor("Help active");
        await act(() => c.requests.settled());
        expect(renders).toHaveLength(1);
        expect(c.app.router.state.location.pathname).toBe("/help/overview");
        await act(() => c.app.router.navigate({ to: "/help/$topic/details", params: { topic: "syntax" }, search: { page: "042", keep: "yes" } }));
        const details = await c.waitFor("Raw page: 042");
        expect(details).toContain("Page: 42");
        expect(details).toContain("Help active");
        expect(c.app.router.state.location.search.page).toBe("042");
        holding = true;
        await c.press("n", { ctrl: true });
        try {
          await c.waitFor("Opening");
          await act(() => until(() => !!release));
        } finally { holding = false; release?.(); }
        await c.waitFor("Raw page: 43");
        expect(c.app.router.state.location.search).toMatchObject({ page: "43", keep: "yes" });
        await c.press("left", { meta: true });
        await act(() => until(() => c.app.router.state.location.pathname === "/help/overview"));
        await c.waitFor("Raw page: 1");
        for (const value of ["bad", "0", "-2", "2.5"]) {
          await act(() => c.app.router.navigate({ to: "/help/$topic", params: { topic: "validation" }, search: { page: value } }));
          expect(await c.waitFor(`Raw page: ${value}`)).toContain("Page: 1");
        }
        await act(() => c.app.router.navigate({ to: "/" }));
        await c.waitFor("Help inactive");
      }, TEST_TIMEOUT_MS);
      TEST
      bun test tests/library-eval.test.ts --timeout 60000
---

Add a help section with Server pages at `/help/<topic>` and `/help/<topic>/details`. These
pages show the topic and an integer page number from the `page` search param (default 1;
invalid or nonpositive input also becomes 1). Show the raw search value too, so `page=042`
still displays `042` beside the parsed number 42. Do not change the generated route file by
hand or add dependencies.

Make a persistent header in `components/RouteTools.tsx`, exported as `RouteTools`, and render
it in the root layout. The header shows whether any help screen is active, including the
details screen. It has these shortcuts and lists them in its help footer:

- Ctrl+H opens `/help/overview?page=1`.
- Ctrl+P warms `/help/overview?page=1` in the background so opening it immediately afterward
  can use the cached result.
- Ctrl+N advances the page number on the current help screen, preserving other search keys
  and replacing the current history entry.
- Alt+Left goes back when there is an entry to go back to; otherwise show `Back unavailable`.

Use the app's typed navigation APIs throughout. Keep `bun run verify` passing.

The minimal root layout gives the header the whole terminal, with no existing shortcuts.
Use the exact labels `Help active` / `Help inactive`, `Raw page: <raw value>`, and
`Page: <parsed number>`. While navigation is pending, the persistent header shows
`Opening`; after it completes, it shows `Ready`.
