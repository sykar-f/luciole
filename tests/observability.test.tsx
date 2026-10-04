/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { act } from "react";
import { Renderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instrumentTracing } from "../packages/core/src/client";
import {
  BUILD_TEST_MS,
  launch,
  privateBuild,
  until,
  WAIT_MS,
  importClient,
  destroy,
  draftOf,
  renderable,
  wire,
  type TestUI,
} from "./helpers";

const built = await privateBuild("examples/notes");

test(
  "the overlay shows no request while typing and one timed call per save",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "luciole-observe-"));
    const server = await launch(join(built.output, "server/index.js"), {
      NOTES_DB: join(dir, "notes.sqlite"),
      NOTES_AUTOSAVE_MS: "0",
    });
    const { createApp, Shell } = await importClient(built.directory, "observe");
    const app = createApp({ url: server.url, initialPath: "/notes/1", latencyMs: 40 });
    // A fake OpenTelemetry tracer: one span per request, ended with its body.
    const spans: { name: string; attributes: Record<string, unknown>; ended: boolean }[] = [];
    const stop = instrumentTracing(app, {
      startSpan(name, options = {}) {
        const span = { name, attributes: { ...options.attributes }, ended: false };
        spans.push(span);
        return {
          setAttribute: (key, value) => (span.attributes[key] = value),
          setStatus: () => {},
          end: () => (span.ended = true),
        };
      },
    });
    const requests = wire(app);
    let rendered: TestUI | undefined;
    try {
      await app.router.load();
      const ui = await testRender(<Shell app={app} />, { width: 100, height: 30 });
      rendered = ui;
      const overlay = async () => {
        await ui.renderOnce();
        return (
          ui
            .captureCharFrame()
            .split("\n")
            .find((l) => l.includes("requests ")) ?? ""
        );
      };
      // The sidebar reads its list once mounted: counted before the overlay opens.
      await act(async () => until(() => ui.captureCharFrame().includes("Shopping list")));
      await act(async () => {
        ui.mockInput.pressKey("t", { ctrl: true });
      });
      expect(await overlay()).toContain("requests 0 · open 0 · 0B · rtt –");
      // Return edits the note: a local change, like typing.
      await act(async () => {
        ui.mockInput.pressEnter();
      });
      await act(async () => {
        await ui.mockInput.typeText("hello");
        const field = renderable(ui, "note-1", Renderable);
        await ui.mockMouse.scroll(field.x, field.y, "down");
      });
      expect(await overlay()).toContain("requests 0 · open 0 · 0B");
      const before = requests.finished.length;
      await act(async () => {
        ui.mockInput.pressKey("s", { ctrl: true });
      });
      const draft = draftOf(app, "1");
      await act(async () => {
        await until(() => !draft.pending);
        // The save, the page and the list read have all ended, and nothing else is open.
        await until(
          () => requests.finished.length - before >= 3 && requests.open.size === 0,
          WAIT_MS,
        );
      });
      // The save, then the page and the list it invalidated.
      const line = await overlay();
      expect(line).toMatch(/requests 3 · open 0 · \d+B · rtt \d+ms/);
      expect(Number(/rtt (\d+)ms/.exec(line)?.[1])).toBeGreaterThanOrEqual(40);
      // Its last lines: the list read again after the save.
      expect(ui.captureCharFrame()).toContain("← action listNotes 200");
      const listing = (s: (typeof spans)[number]) =>
        String(s.attributes["luciole.target"]).endsWith("#listNotes");
      expect(spans.filter(listing).map((s) => s.ended)).toEqual([true, true]);
      const page = spans.filter((s) => !listing(s));
      expect(page.map((s) => [s.name, s.attributes["luciole.target"], s.ended])).toEqual([
        ["luciole.render", "/notes/[id]", true],
        ["luciole.action", expect.stringContaining("#saveNote"), true],
        ["luciole.render", "/notes/[id]", true],
      ]);
      expect(page[1]?.attributes["http.response.status_code"]).toBe(200);
    } finally {
      await act(() => requests.settled().catch(() => {}));
      stop();
      await destroy(rendered);
      await server.stop();
      await rm(dir, { recursive: true, force: true });
    }
  },
  BUILD_TEST_MS,
);
