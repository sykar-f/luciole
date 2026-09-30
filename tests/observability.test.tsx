/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { act } from "react";
import { Renderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../packages/luciole/src/build";
import { instrumentTracing } from "../packages/luciole/src/client";
import { launch, until, importClient, destroy, draftOf, renderable, type TestUI } from "./helpers";

const root = resolve("examples/notes");

test("the overlay shows no request while typing and one timed call per save", async () => {
  await build(root);
  const dir = await mkdtemp(join(tmpdir(), "luciole-observe-"));
  const server = await launch(join(root, ".luciole/server/index.js"), {
    NOTES_DB: join(dir, "notes.sqlite"),
  });
  const { createApp, Shell } = await importClient(root, "observe");
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
    await act(async () => {
      ui.mockInput.pressKey("t", { ctrl: true });
    });
    expect(await overlay()).toContain("requests 0 · open 0 · 0B · rtt –");
    await act(async () => {
      await ui.mockInput.typeText("hello");
      const field = renderable(ui, "note-1", Renderable);
      await ui.mockMouse.scroll(field.x, field.y, "down");
    });
    expect(await overlay()).toContain("requests 0 · open 0 · 0B");
    await act(async () => {
      ui.mockInput.pressKey("s", { ctrl: true });
    });
    const draft = draftOf(app, "1");
    await act(async () => {
      await until(() => !draft.pending);
      await Bun.sleep(150);
    });
    // The save, then the page it invalidated.
    const line = await overlay();
    expect(line).toMatch(/requests 2 · open 0 · \d+B · rtt \d+ms/);
    expect(Number(/rtt (\d+)ms/.exec(line)?.[1])).toBeGreaterThanOrEqual(40);
    expect(ui.captureCharFrame()).toContain("← action saveNote 200");
    expect(spans.map((s) => [s.name, s.attributes["luciole.target"], s.ended])).toEqual([
      ["luciole.render", "/notes/[id]", true],
      ["luciole.action", expect.stringContaining("#saveNote"), true],
      ["luciole.render", "/notes/[id]", true],
    ]);
    expect(spans[1].attributes["http.response.status_code"]).toBe(200);
  } finally {
    stop();
    await destroy(rendered);
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
