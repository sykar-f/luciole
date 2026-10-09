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
  cat > actions/export-collection.ts <<'ACTION'
  "use server";
  export async function exportCollection(): Promise<string> {
    await Bun.sleep(2400);
    return "Export ready (2 notes)";
  }
  ACTION
  bunx oxfmt --write app/layout.tsx actions/export-collection.ts
# c1: project health. c2: a timer/timeline reachable from the page.
# c3: painted waiting element changes over twelve samples, occupies <=3 rows,
# every other row stays painted identically, content anchors keep coordinates,
# and the supplied Server result arrives over an action request.
# The planted delay gives a finite observation window; elapsed duration is not
# scored. A glyph change or an opacity/colour pulse both qualify as animation.
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
      const source = await reachable("app/transfer/page.tsx");
      expect(source).toMatch(/(?:useTimeline\s*\(|setInterval\s*\(|setTimeout\s*\(|requestAnimationFrame\s*\()/);
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
      test("export visibly progresses in place and reports the Server result", async () => {
        const { server, client: c } = await launch("/transfer");
        await using s = server;
        await using client = c;
        await see(c, "Export notes");
        await move(c, 59, 19);
        const idle = await c.frame();
        const idlePaint = paint(c);
        const anchors = ["Collection export", "Orchard plan", "Packing list"].map(t => ({ text: t, at: cell(c, t) }));
        const finished = c.requests.finished.length;
        await c.click("Export notes");
        await move(c, 59, 19);
        let first;
        // Await the visible wait, never visual-idle: an animation should not settle.
        for (let i = 0; i < 20; i++) {
          const frame = await c.frame();
          if (JSON.stringify(paint(c)) !== JSON.stringify(idlePaint) && !frame.includes("Export ready (2 notes)")) { first = paint(c); break; }
          await act(async () => { await Bun.sleep(25); });
        }
        expect(first, "a visible waiting state").toBeDefined();
        const region = first.flatMap((row, y) => JSON.stringify(row) !== JSON.stringify(idlePaint[y]) ? [y] : []);
        expect(region.length, "compact waiting element").toBeGreaterThan(0);
        expect(region.length).toBeLessThanOrEqual(3);
        let changed = false;
        for (let i = 0; i < 12; i++) {
          await act(async () => { await Bun.sleep(100); });
          const frame = await c.frame();
          expect(frame).not.toContain("Export ready (2 notes)");
          const next = paint(c);
          for (const a of anchors) expect(cell(c, a.text)).toEqual(a.at);
          for (let y = 0; y < next.length; y++) {
            if (region.includes(y)) {
              if (JSON.stringify(next[y]) !== JSON.stringify(first[y])) changed = true;
            } else expect(next[y], `stationary row ${y}`).toEqual(first[y]);
          }
        }
        expect(changed, "waiting element changes glyphs or painted colours over time").toBe(true);
        const result = await see(c, "Export ready (2 notes)");
        for (const a of anchors) { expect(result).toContain(a.text); expect(cell(c, a.text)).toEqual(a.at); }
        await c.requests.settled();
        expect(c.requests.finished.slice(finished).some(r => r.kind === "action" && r.type === "end")).toBe(true);
      }, TEST_TIMEOUT_MS);

      TEST
      bun test tests/rich-ux-eval.test.ts --timeout 60000
---

Add a collection export page at `/transfer` for people who have never used this app. Show
"Collection export", the notes "Orchard plan" and "Packing list", and an "Export notes"
action that calls the supplied `actions/export-collection.ts` Server function. It takes a
few seconds to prepare the file; let people know what is happening until it returns, then
show its result. Keep `bun run verify` passing.
