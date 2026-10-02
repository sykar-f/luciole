/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { BoxRenderable, InputRenderable, ScrollBoxRenderable } from "@opentui/core";
import { join, resolve } from "node:path";
import { build } from "../packages/core/src/build";
import {
  launch,
  until,
  importClient,
  destroy,
  metricsOf,
  renderable,
  type TestUI,
} from "./helpers";

test("500 ms RTT delays Flight and actions while input, hover and scroll stay local", async () => {
  const directory = resolve("examples/latency");
  await build(directory);
  const server = await launch(join(directory, ".luciole/server/index.js"));
  const { createApp, Shell } = await importClient(directory, "latency");
  const app = createApp({ url: server.url, latencyMs: 500 });
  let rendered: TestUI | undefined;
  const counts = () => metricsOf(server);
  try {
    const start = performance.now();
    await app.router.load();
    expect(performance.now() - start).toBeGreaterThanOrEqual(480);
    const ui = await testRender(<Shell app={app} />, { width: 100, height: 30 });
    rendered = ui;
    await ui.renderOnce();
    const before = await counts();
    const scroll = renderable(ui, "latency-scroll", ScrollBoxRenderable);
    const hover = renderable(ui, "latency-hover", BoxRenderable);
    const field = renderable(ui, "latency-input", InputRenderable);
    const top = scroll.scrollTop;
    const actionStart = performance.now();
    await act(async () => {
      ui.mockInput.pressEnter();
    });
    await act(async () => {
      await ui.mockInput.typeText("abc");
      await ui.mockMouse.moveTo(hover.x + 2, hover.y + 1);
      await ui.mockMouse.scroll(scroll.x + 2, scroll.y + 2, "down");
      await Bun.sleep(30);
    });
    await ui.renderOnce();
    // Local results are on screen while the Server has not answered yet.
    expect(field.value).toBe("abc");
    expect(scroll.scrollTop).toBeGreaterThan(top);
    expect(ui.captureCharFrame()).toContain("Waiting for Server");
    expect(ui.captureCharFrame()).not.toContain("Server replied in");
    expect(await counts()).toEqual(before);
    // Hover must produce a visible local frame, independently of the subsequent wheel event.
    await act(async () => {
      await ui.mockMouse.moveTo(hover.x + 2, hover.y + 1);
    });
    await ui.renderOnce();
    expect(ui.captureCharFrame()).toContain("Hover active (local)");
    // A read-only Server Function does not refresh the page.
    await act(async () => {
      await Bun.sleep(600);
    });
    await ui.renderOnce();
    expect(ui.captureCharFrame()).toContain("Server replied in");
    expect(performance.now() - actionStart).toBeGreaterThanOrEqual(480);
    expect(await counts()).toEqual({ renders: before.renders, actions: before.actions + 1 });
    // An explicit refresh is delayed too, and keeps the mounted input.
    const refreshStart = performance.now();
    const fetching = () => app.router.state.matches.some((m) => m.isFetching);
    await act(async () => {
      // The mounted page revalidates in the background.
      await app.refresh();
      await until(() => !fetching());
    });
    expect(performance.now() - refreshStart).toBeGreaterThanOrEqual(480);
    expect(await counts()).toEqual({ renders: before.renders + 1, actions: before.actions + 1 });
    expect(field.value).toBe("abc");
    expect(ui.renderer.root.findDescendantById("latency-input")).toBe(field);
  } finally {
    await destroy(rendered);
    await server.stop();
  }
});
