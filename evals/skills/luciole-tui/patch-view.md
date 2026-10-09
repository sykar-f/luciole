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
      file: components/PatchView.tsx
      pattern: <diff[\s>]
  - run: bun run verify
  - run: |
      mkdir -p tests
      cp app/patch/page.tsx app/patch/page.tsx.eval-backup
      trap 'mv app/patch/page.tsx.eval-backup app/patch/page.tsx; rm -f tests/library-eval.test.ts' EXIT
      cat > tests/library-eval.test.ts <<'TEST'
      import { expect, test } from "bun:test";
      import { act } from "react";
      import { buildApp, startServer, openClient, until, TEST_TIMEOUT_MS } from "@luciole-sh/core/test";
      const originalApp = await buildApp();
      await Bun.write("app/patch/page.tsx", "import { PatchView } from \"../../components/PatchView\";\nconst lines = Array.from({ length: 80 }, (_, i) => String(i+1).padStart(3, \"0\"));\nconst patch = [\"--- a/large.ts\", \"+++ b/large.ts\", \"@@ -1,80 +1,80 @@\", ...lines.map(n => `-old_${n}`), ...lines.map(n => `+new_${n}`)].join(\"\\n\") + \"\\n\";\nexport default function Page() { return <PatchView patch={patch} />; }\n");
      const app = await buildApp();
      function nodes(node) { return [node, ...node.getChildren().flatMap(nodes)]; }
      function native(client, name) {
        const found = nodes(client.ui.renderer.root).filter(n => n.constructor.name.includes(name) && n.visible && n.width > 0 && n.height > 0 && n.screenX >= 0 && n.screenX < client.ui.renderer.width && n.screenY >= 0 && n.screenY < client.ui.renderer.height);
        expect(found).toHaveLength(1);
        for (let n = found[0]; n; n = n.parent) expect(n.visible).toBe(true);
        return found[0];
      }
      test("the submitted Server screen passes the sample patch", async () => {
        await using server = await startServer(originalApp, { NOTES_DB: ":memory:" });
        await using c = await openClient(originalApp, server, { width: 100, height: 24 });
        await act(() => c.app.router.navigate({ to: "/patch" }));
        const frame = await c.settled("Welcome");
        expect(frame).toContain("Hello");
        const widget = native(c, "DiffRenderable");
        expect(widget.diff).toContain('const greeting = "Hello";');
        expect(widget.diff).toContain('const greeting = "Welcome";');
      }, TEST_TIMEOUT_MS);
      test("visible native patch toggles, scrolls and resizes", async () => {
        await using server = await startServer(app, { NOTES_DB: ":memory:" });
        await using c = await openClient(app, server, { width: 100, height: 24 });
        await act(() => c.app.router.navigate({ to: "/patch" }));
        await c.settled("old_001");
        const widget = native(c, "DiffRenderable");
        expect(widget.showLineNumbers).toBe(true);
        expect(widget.addedBg.toString()).not.toBe(widget.removedBg.toString());
        const first = await c.frame();
        const mode = widget.view;
        await c.press("v", { ctrl: true });
        await c.settled("new_001");
        expect(widget.view).toBe(mode === "unified" ? "split" : "unified");
        expect(await c.frame()).not.toBe(first);
        await c.press("v", { ctrl: true });
        await c.settled("old_001");
        for (let i=0; i<14; i++) await act(async () => c.ui.mockInput.pressKey("\x1b[6~"));
        const bottom = await c.settled("new_060");
        expect(bottom).not.toContain("old_001");
        for (let i=0; i<14; i++) await act(async () => c.ui.mockInput.pressKey("\x1b[5~"));
        await c.settled("old_001");
        await act(async () => c.ui.resize(32, 24));
        const narrow = await c.settled("old_001");
        native(c, "DiffRenderable");
          expect(narrow.toLowerCase()).toContain("unified");
      for (let i=0; i<14; i++) await act(async () => c.ui.mockInput.pressKey("\x1b[6~"));
      await c.settled("new_060");
      }, TEST_TIMEOUT_MS);
      TEST
      bun test tests/library-eval.test.ts --timeout 60000
---

Add a patch review screen at `/patch`. Put its interactive part in
`components/PatchView.tsx`, exported as `PatchView`, receiving a `patch: string` prop.
The Server page passes this sample unified patch:

```diff
--- a/hello.ts
@@ -1,2 +1,2 @@
-const greeting = "Hello";
+const greeting = "Welcome";
 console.log(greeting);
```

Show added and removed lines in different colors with line numbers. Let Ctrl+V switch between
a unified view and side-by-side old/new columns; show the current view and the shortcut in
the footer. Support scrolling when patches exceed the screen and readable output at a
narrow terminal width. Keep `bun run verify` passing.

PageDown and PageUp scroll the patch. Start in unified mode. The minimal root layout
gives the screen the whole terminal.
