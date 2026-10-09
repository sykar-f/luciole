---
expect-skill: luciole-tui
timeout-minutes: 12
setup: |
  cat > app/layout.tsx <<'LAYOUT'
  "use client";
  import type { LayoutProps } from "@luciole-sh/core/client";
  export default function Layout({ children }: LayoutProps) {
    return <box flexDirection="column" flexGrow={1}>{children}</box>;
  }
  LAYOUT
  bunx oxfmt --write app/layout.tsx
# c1: project health. c2: reachable mouse/button and hover mechanisms.
# c3: all three effects with clicks alone, through direct controls or a menu.
# c4: actions hidden until opening, contextual and visible entrances,
# placement, target identity, Escape and outside dismissal. c5: painted hover.
# c6: at 60x20, <=12 occupied rows leaves eight rows for reading/expansion;
# no permanent Duplicate/Delete inventory and <=4 key hints keep chrome small.
# A visible entrance is a More/Actions label or a familiar ellipsis glyph.
# Near the click means <=24 columns (one menu width) and <=5 rows, allowing
# clamping at terminal edges. These are design criteria, not speed gates.
checks:
  - run: bun run verify
  - run: |
      bun - <<'CODE'
      import { expect } from "bun:test";
      import { dirname, resolve } from "node:path";
      const seen = new Set();
      async function reachable(file) {
        if (seen.has(file)) return "";
        seen.add(file);
        const source = await Bun.file(file).text();
        const children = [];
        for (const m of source.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/g)) {
          const base = resolve(dirname(file), m[1]);
          for (const suffix of ["", ".tsx", ".ts", "/index.tsx", "/index.ts"]) {
            if (await Bun.file(base+suffix).exists()) { children.push(await reachable(base+suffix)); break; }
          }
        }
        return source+"\n"+children.join("\n");
      }
      const source = await reachable("app/desk/page.tsx");
      expect(source).toMatch(/onMouse(?:Down|Up)[\s\S]*?(?:button\s*===?\s*(?:MouseButton(?:s)?\.RIGHT|2)|(?:MouseButton(?:s)?\.RIGHT|2)\s*===?\s*\w+\.button)/);
      expect(source).toMatch(/onMouse(?:Over|Enter)/);
      expect(source).toMatch(/onMouse(?:Out|Leave)/);
      CODE
  - run: |
      mkdir -p tests
      trap 'rm -f tests/rich-ux-eval.test.ts' EXIT
      cat > tests/rich-ux-eval.test.ts <<'TEST'
      import { expect, test } from "bun:test";
      import { act } from "react";
      import { MouseButtons } from "@opentui/core/testing";
      import { buildApp, startServer, openClient, TEST_TIMEOUT_MS } from "@luciole-sh/core/test";
      const app = await buildApp();
      async function launch(route) {
        const server = await startServer(app, { NOTES_DB: ":memory:" });
        try {
          let client;
          await act(async () => { client = await openClient(app, server, { width: 60, height: 20 }); });
          await act(() => client.app.router.navigate({ to: route }));
          return { server, client };
        } catch (error) { await server[Symbol.asyncDispose](); throw error; }
      }
      function cell(c, text) {
        const rows = c.ui.captureCharFrame().split("\n");
        const y = rows.findIndex(row => row.includes(text));
        const p = y < 0 ? undefined : { x: rows[y].indexOf(text), y };
        expect(p, `visible ${text}`).toBeDefined();
        return p;
      }
      async function hidden(c, text) {
        for (let i = 0; i < 100; i++) {
          await act(async () => { await Bun.sleep(10); await c.ui.renderOnce(); });
          if (!c.ui.captureCharFrame().includes(text)) return;
        }
        throw new Error(`Still shown: ${text}`);
      }
      async function move(c, x, y) {
        await act(async () => { await c.ui.mockMouse.moveTo(x, y); });
        await c.frame();
      }
      function paint(c) {
        return c.ui.captureSpans().lines.map(line => line.spans.flatMap(span =>
          Array.from({ length: span.width }, () => [span.text, span.fg.toInts(), span.bg.toInts(), span.attributes])
        ));
      }
      async function see(c, text) {
        let frame = "";
        for (let i = 0; i < 500; i++) {
          await act(async () => { await Bun.sleep(10); await c.ui.renderOnce(); });
          frame = c.ui.captureCharFrame();
          if (frame.includes(text)) return frame;
        }
        throw new Error(`Not shown: ${text}\n${frame}`);
      }
      function shownAction(frame, action) { return new RegExp("\\b"+action+"\\b").test(frame); }
      async function menu(c, title, right = true) {
        const before = await c.frame();
        for (const action of ["Duplicate", "Delete"]) expect(shownAction(before, action), "secondary actions appear only after opening the menu").toBe(false);
        if (right) await c.click(title, MouseButtons.RIGHT);
        else {
          const frame = await c.frame();
          const rows = frame.split("\n");
          const at = cell(c, title);
          const candidates = rows.flatMap((row, y) => [...row.matchAll(/More(?:…|\.\.\.)?|Actions|[⋮⋯…]|\.\.\./gi)].map(m => ({ x: m.index, y })))
            .sort((a, b) => Math.abs(a.y-at.y)-Math.abs(b.y-at.y));
          expect(candidates.length, "visible named or ellipsis action entrance").toBeGreaterThan(0);
          for (const p of candidates) {
            await act(async () => { await c.ui.mockMouse.click(p.x, p.y); });
            const shown = await c.frame();
            if (["Open", "Duplicate", "Delete"].every(s => shownAction(shown, s))) break;
          }
        }
        const frame = await see(c, "Duplicate");
        for (const action of ["Open", "Duplicate", "Delete"]) expect(shownAction(frame, action)).toBe(true);
        return frame;
      }
      async function choose(c, title, action) {
        // Direct actions qualify for click-only reachability; c4 judges menus.
        if (!shownAction(await c.frame(), action)) await menu(c, title, false);
        await c.click(action);
      }
      test("note actions work with clicks alone", async () => {
        const { server, client: c } = await launch("/desk");
        await using s = server;
        await using client = c;
        await see(c, "Orchard plan");
        const closed = await c.frame();
        await choose(c, "Orchard plan", "Open");
        expect(await see(c, "Prune pear trees.")).not.toEqual(closed);
        await choose(c, "Orchard plan", "Duplicate");
        await see(c, "Orchard plan copy");
        await choose(c, "Orchard plan", "Delete");
        const frame = await see(c, "Deleted");
        expect(frame).toContain("Packing list");
        expect(frame).toContain("Orchard plan copy");
        expect(frame.replaceAll("Orchard plan copy", "")).not.toContain("Orchard plan");
      }, TEST_TIMEOUT_MS);

      TEST
      bun test tests/rich-ux-eval.test.ts --timeout 60000
  - run: |
      mkdir -p tests
      trap 'rm -f tests/rich-ux-eval.test.ts' EXIT
      cat > tests/rich-ux-eval.test.ts <<'TEST'
      import { expect, test } from "bun:test";
      import { act } from "react";
      import { MouseButtons } from "@opentui/core/testing";
      import { buildApp, startServer, openClient, TEST_TIMEOUT_MS } from "@luciole-sh/core/test";
      const app = await buildApp();
      async function launch(route) {
        const server = await startServer(app, { NOTES_DB: ":memory:" });
        try {
          let client;
          await act(async () => { client = await openClient(app, server, { width: 60, height: 20 }); });
          await act(() => client.app.router.navigate({ to: route }));
          return { server, client };
        } catch (error) { await server[Symbol.asyncDispose](); throw error; }
      }
      function cell(c, text) {
        const rows = c.ui.captureCharFrame().split("\n");
        const y = rows.findIndex(row => row.includes(text));
        const p = y < 0 ? undefined : { x: rows[y].indexOf(text), y };
        expect(p, `visible ${text}`).toBeDefined();
        return p;
      }
      async function hidden(c, text) {
        for (let i = 0; i < 100; i++) {
          await act(async () => { await Bun.sleep(10); await c.ui.renderOnce(); });
          if (!c.ui.captureCharFrame().includes(text)) return;
        }
        throw new Error(`Still shown: ${text}`);
      }
      async function move(c, x, y) {
        await act(async () => { await c.ui.mockMouse.moveTo(x, y); });
        await c.frame();
      }
      function paint(c) {
        return c.ui.captureSpans().lines.map(line => line.spans.flatMap(span =>
          Array.from({ length: span.width }, () => [span.text, span.fg.toInts(), span.bg.toInts(), span.attributes])
        ));
      }
      async function see(c, text) {
        let frame = "";
        for (let i = 0; i < 500; i++) {
          await act(async () => { await Bun.sleep(10); await c.ui.renderOnce(); });
          frame = c.ui.captureCharFrame();
          if (frame.includes(text)) return frame;
        }
        throw new Error(`Not shown: ${text}\n${frame}`);
      }
      function shownAction(frame, action) { return new RegExp("\\b"+action+"\\b").test(frame); }
      async function menu(c, title, right = true) {
        const before = await c.frame();
        for (const action of ["Duplicate", "Delete"]) expect(shownAction(before, action), "secondary actions appear only after opening the menu").toBe(false);
        if (right) await c.click(title, MouseButtons.RIGHT);
        else {
          const frame = await c.frame();
          const rows = frame.split("\n");
          const at = cell(c, title);
          const candidates = rows.flatMap((row, y) => [...row.matchAll(/More(?:…|\.\.\.)?|Actions|[⋮⋯…]|\.\.\./gi)].map(m => ({ x: m.index, y })))
            .sort((a, b) => Math.abs(a.y-at.y)-Math.abs(b.y-at.y));
          expect(candidates.length, "visible named or ellipsis action entrance").toBeGreaterThan(0);
          for (const p of candidates) {
            await act(async () => { await c.ui.mockMouse.click(p.x, p.y); });
            const shown = await c.frame();
            if (["Open", "Duplicate", "Delete"].every(s => shownAction(shown, s))) break;
          }
        }
        const frame = await see(c, "Duplicate");
        for (const action of ["Open", "Duplicate", "Delete"]) expect(shownAction(frame, action)).toBe(true);
        return frame;
      }
      async function choose(c, title, action) {
        // Direct actions qualify for click-only reachability; c4 judges menus.
        if (!shownAction(await c.frame(), action)) await menu(c, title, false);
        await c.click(action);
      }
      test("right-click targets the note, places its menu nearby and dismisses it", async () => {
        const { server, client: c } = await launch("/desk");
        await using s = server;
        await using client = c;
        await see(c, "Packing list");
        const p = cell(c, "Packing list");
        await menu(c, "Packing list");
        const action = cell(c, "Duplicate");
        expect(Math.abs(action.x-p.x)).toBeLessThanOrEqual(24);
        expect(Math.abs(action.y-p.y)).toBeLessThanOrEqual(5);
        await c.press("escape");
        await hidden(c, "Duplicate");
        await menu(c, "Packing list", false);
        await act(async () => { await c.ui.mockMouse.click(59, 19); });
        await hidden(c, "Duplicate");
        await menu(c, "Packing list");
        await c.click("Duplicate");
        const frame = await see(c, "Packing list copy");
        expect(frame).toContain("Orchard plan");
        expect(frame).not.toContain("Orchard plan copy");
      }, TEST_TIMEOUT_MS);

      TEST
      bun test tests/rich-ux-eval.test.ts --timeout 60000
  - run: |
      mkdir -p tests
      trap 'rm -f tests/rich-ux-eval.test.ts' EXIT
      cat > tests/rich-ux-eval.test.ts <<'TEST'
      import { expect, test } from "bun:test";
      import { act } from "react";
      import { MouseButtons } from "@opentui/core/testing";
      import { buildApp, startServer, openClient, TEST_TIMEOUT_MS } from "@luciole-sh/core/test";
      const app = await buildApp();
      async function launch(route) {
        const server = await startServer(app, { NOTES_DB: ":memory:" });
        try {
          let client;
          await act(async () => { client = await openClient(app, server, { width: 60, height: 20 }); });
          await act(() => client.app.router.navigate({ to: route }));
          return { server, client };
        } catch (error) { await server[Symbol.asyncDispose](); throw error; }
      }
      function cell(c, text) {
        const rows = c.ui.captureCharFrame().split("\n");
        const y = rows.findIndex(row => row.includes(text));
        const p = y < 0 ? undefined : { x: rows[y].indexOf(text), y };
        expect(p, `visible ${text}`).toBeDefined();
        return p;
      }
      async function hidden(c, text) {
        for (let i = 0; i < 100; i++) {
          await act(async () => { await Bun.sleep(10); await c.ui.renderOnce(); });
          if (!c.ui.captureCharFrame().includes(text)) return;
        }
        throw new Error(`Still shown: ${text}`);
      }
      async function move(c, x, y) {
        await act(async () => { await c.ui.mockMouse.moveTo(x, y); });
        await c.frame();
      }
      function paint(c) {
        return c.ui.captureSpans().lines.map(line => line.spans.flatMap(span =>
          Array.from({ length: span.width }, () => [span.text, span.fg.toInts(), span.bg.toInts(), span.attributes])
        ));
      }
      async function see(c, text) {
        let frame = "";
        for (let i = 0; i < 500; i++) {
          await act(async () => { await Bun.sleep(10); await c.ui.renderOnce(); });
          frame = c.ui.captureCharFrame();
          if (frame.includes(text)) return frame;
        }
        throw new Error(`Not shown: ${text}\n${frame}`);
      }
      test("actionable note has reversible painted hover feedback", async () => {
        const { server, client: c } = await launch("/desk");
        await using s = server;
        await using client = c;
        await see(c, "Orchard plan");
        const p = cell(c, "Orchard plan");
        await move(c, 59, 19);
        const before = paint(c)[p.y];
        await move(c, p.x, p.y);
        expect(paint(c)[p.y]).not.toEqual(before);
        await move(c, 59, 19);
        expect(paint(c)[p.y]).toEqual(before);
      }, TEST_TIMEOUT_MS);

      TEST
      bun test tests/rich-ux-eval.test.ts --timeout 60000
  - run: |
      mkdir -p tests
      trap 'rm -f tests/rich-ux-eval.test.ts' EXIT
      cat > tests/rich-ux-eval.test.ts <<'TEST'
      import { expect, test } from "bun:test";
      import { act } from "react";
      import { MouseButtons } from "@opentui/core/testing";
      import { buildApp, startServer, openClient, TEST_TIMEOUT_MS } from "@luciole-sh/core/test";
      const app = await buildApp();
      async function launch(route) {
        const server = await startServer(app, { NOTES_DB: ":memory:" });
        try {
          let client;
          await act(async () => { client = await openClient(app, server, { width: 60, height: 20 }); });
          await act(() => client.app.router.navigate({ to: route }));
          return { server, client };
        } catch (error) { await server[Symbol.asyncDispose](); throw error; }
      }
      function cell(c, text) {
        const rows = c.ui.captureCharFrame().split("\n");
        const y = rows.findIndex(row => row.includes(text));
        const p = y < 0 ? undefined : { x: rows[y].indexOf(text), y };
        expect(p, `visible ${text}`).toBeDefined();
        return p;
      }
      async function hidden(c, text) {
        for (let i = 0; i < 100; i++) {
          await act(async () => { await Bun.sleep(10); await c.ui.renderOnce(); });
          if (!c.ui.captureCharFrame().includes(text)) return;
        }
        throw new Error(`Still shown: ${text}`);
      }
      async function move(c, x, y) {
        await act(async () => { await c.ui.mockMouse.moveTo(x, y); });
        await c.frame();
      }
      function paint(c) {
        return c.ui.captureSpans().lines.map(line => line.spans.flatMap(span =>
          Array.from({ length: span.width }, () => [span.text, span.fg.toInts(), span.bg.toInts(), span.attributes])
        ));
      }
      async function see(c, text) {
        let frame = "";
        for (let i = 0; i < 500; i++) {
          await act(async () => { await Bun.sleep(10); await c.ui.renderOnce(); });
          frame = c.ui.captureCharFrame();
          if (frame.includes(text)) return frame;
        }
        throw new Error(`Not shown: ${text}\n${frame}`);
      }
      test("small terminal preserves content and hides secondary action inventories", async () => {
        const { server, client: c } = await launch("/desk");
        await using s = server;
        await using client = c;
        const frame = await see(c, "Packing list");
        expect(frame).toContain("Orchard plan");
        expect(frame).not.toMatch(/Duplicate|Delete/i);
        const rows = frame.split("\n").filter(r => r.trim());
        expect(rows.length).toBeLessThanOrEqual(12);
        const keys = frame.match(/(?:Ctrl[+ -]|Alt[+ -]|Esc(?:ape)?|Enter|Tab|F\d+|\[[a-z]\])/gi) ?? [];
        expect(keys.length).toBeLessThanOrEqual(4);
      }, TEST_TIMEOUT_MS);

      TEST
      bun test tests/rich-ux-eval.test.ts --timeout 60000
---

Add a notes desk at `/desk` for people who have never used this app. Start with two notes:
"Orchard plan" containing "Prune pear trees." and "Packing list" containing "Bring boots.".
People need to Open a note and read its text, Duplicate it as "<title> copy", or Delete it
while keeping the other notes. Use those three action names and report "Duplicated" or
"Deleted" after those operations. Session-local state is enough. Keep `bun run verify`
passing.
