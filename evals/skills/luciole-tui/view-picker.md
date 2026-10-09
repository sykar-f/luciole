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
      file: components/ViewPicker.tsx
      pattern: <tab-select[\s>]
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
      test("visible native picker selects, overflows and respects focus", async () => {
        await using server = await startServer(app, { NOTES_DB: ":memory:" });
        await using c = await openClient(app, server, { width: 110, height: 24 });
        await act(() => c.app.router.navigate({ to: "/preferences" }));
        await c.settled("General");
        const widget = native(c, "TabSelectRenderable");
        expect(widget.focused).toBe(true);
        expect(widget.getSelectedOption().name).toBe("General");
        await c.press("right");
        await c.press("return");
        await c.waitFor("Chosen: Appearance");
        expect(widget.getSelectedOption().name).toBe("Appearance");
        await c.press("left");
        await c.press("return");
        await c.waitFor("Chosen: General");
        await act(async () => c.ui.resize(32, 24));
        await c.frame();
        expect(widget.showScrollArrows).toBe(true);
        for (let i=0; i<5; i++) await c.press("right");
        await c.press("return");
        const narrow = await c.waitFor("Chosen: About");
        expect(widget.getSelectedOption().name).toBe("About");
        expect(narrow).toMatch(/[◀▶←→‹›<>]/);
        native(c, "TabSelectRenderable");
        await c.press("tab");
        expect(widget.focused).toBe(false);
        await c.type("abc");
        await c.press("left");
        await c.type("Z");
        await c.press("return");
        const typing = await c.waitFor("abZc");
        expect(widget.getSelectedOption().name).toBe("About");
        expect(typing).toContain("Chosen: About");
        await c.press("tab");
        await c.press("left");
        await c.press("return");
        await c.waitFor("Chosen: Storage");
      }, TEST_TIMEOUT_MS);
      TEST
      bun test tests/library-eval.test.ts --timeout 60000
---

Add a preferences screen at `/preferences`. Its Client Component is
`components/ViewPicker.tsx`, exported as `ViewPicker`.
Show a horizontal picker for General, Appearance, Editing, Network, Storage, About, with a
short description under the selected choice. The picker is initially focused. Left/right
move the selection and Enter confirms it, showing `Chosen: <name>` below. Long names should
truncate and choices beyond the terminal width should remain reachable with an overflow
indicator. Keep the footer and the page usable at a narrow terminal width.
Keep `bun run verify` passing.

Add a single-line Filter field. Tab moves focus from the picker to the field and back.
While the field is focused, arrows edit its text and Enter must not confirm a choice.
The minimal root layout gives this screen the whole terminal.
