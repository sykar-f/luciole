---
expect-skill: luciole-tui
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
  - match:
      file: components/FocusDemo.tsx
      pattern: \buseBindings\s*\(
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
      test("plain shortcut yields to both focused fields", async () => {
        await using server = await startServer(app, { NOTES_DB: ":memory:" });
        await using c = await openClient(app, server);
        await act(() => c.app.router.navigate({ to: "/focus" }));
        await c.waitFor("Shortcut count: 0");
        await c.press("x");
        await c.waitFor("Shortcut count: 1");
        await c.press("1", { ctrl: true });
        await c.type("ax");
        expect(await c.waitFor("First: ax")).toContain("Shortcut count: 1");
        await c.press("2", { ctrl: true });
        await c.type("bx");
        const second = await c.waitFor("Second: bx");
        expect(second).toContain("First: ax");
        expect(second).toContain("Shortcut count: 1");
        await c.press("1", { ctrl: true });
        await c.type("c");
        expect(await c.waitFor("First: axc")).toContain("Second: bx");
        await c.press("escape");
        await c.press("x");
        const blurred = await c.waitFor("Shortcut count: 2");
        expect(blurred).toContain("First: axc");
        expect(blurred).toContain("Second: bx");
      }, TEST_TIMEOUT_MS);
      TEST
      bun test tests/library-eval.test.ts --timeout 60000
---

Add a focus demonstration screen at `/focus`, with its interactive part exported as
`FocusDemo` from `components/FocusDemo.tsx`. The root layout is minimal.

Show two initially empty single-line fields, First and Second, with no field focused at
first. Ctrl+1 focuses First, Ctrl+2 focuses Second, and Escape leaves both unfocused.
Keep their text when focus moves. Mirror the values below as `First: <value>` and
`Second: <value>` so they can be read without a cursor covering a character.

The plain key x increments `Shortcut count: <number>` (initially 0) when neither field has
focus. While either field is focused, x types into that field and does not increment the
count. List the shortcuts in the footer. Keep `bun run verify` passing.
