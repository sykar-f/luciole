/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { join, resolve } from "node:path";
import { build } from "../src/build";
import { launch, until } from "./helpers";

test("500 ms RTT delays Flight and actions while input, hover and scroll stay local", async () => {
  const directory = resolve("examples/latency");
  await build(directory);
  const server = await launch(join(directory, ".terminal/server/index.js"));
  const { createApp, Shell } = await import(
    join(directory, ".terminal/client/index.js") + "?latency"
  );
  const app = createApp({ url: server.url, latencyMs: 500 });
  let ui: any;
  const counts = async () =>
    (
      await fetch(server.url + "/test-metrics", {
        headers: { "x-terminal-build": server.buildId },
      })
    ).json();
  try {
    const start = performance.now();
    await app.router.load();
    expect(performance.now() - start).toBeGreaterThanOrEqual(480);
    ui = await testRender(<Shell app={app} />, { width: 100, height: 30 });
    await ui.renderOnce();
    const before = await counts();
    const scroll = ui.renderer.root.findDescendantById("latency-scroll");
    const hover = ui.renderer.root.findDescendantById("latency-hover");
    const field = ui.renderer.root.findDescendantById("latency-input");
    const top = scroll.scrollTop;
    const actionStart = performance.now();
    await act(async () => {
      await ui.mockInput.pressEnter();
    });
    await act(async () => {
      await ui.mockInput.typeText("abc");
      await ui.mockMouse.moveTo(hover.x + 2, hover.y + 1);
      await ui.mockMouse.scroll(scroll.x + 2, scroll.y + 2, "down");
      await Bun.sleep(30);
    });
    await ui.renderOnce();
    expect(performance.now() - actionStart).toBeLessThan(450);
    expect(field.value).toBe("abc");
    expect(scroll.scrollTop).toBeGreaterThan(top);
    expect(ui.captureCharFrame()).toContain("Waiting for Server");
    // Hover must produce a visible local frame, independently of the subsequent wheel event.
    await act(async () => {
      await ui.mockMouse.moveTo(hover.x + 2, hover.y + 1);
    });
    await ui.renderOnce();
    expect(ui.captureCharFrame()).toContain("Hover active (local)");
    await act(async () => {
      await until(() => app.router.state.matches.some((m: any) => m.isFetching));
    });
    expect(performance.now() - actionStart).toBeGreaterThanOrEqual(480);
    // Let the automatic delayed refresh finish before counting server traffic.
    await act(async () => {
      await until(() => !app.router.state.matches.some((m: any) => m.isFetching));
    });
    expect(await counts()).toEqual({ renders: before.renders + 1, actions: before.actions + 1 });
    expect(field.value).toBe("abc");
    expect(ui.renderer.root.findDescendantById("latency-input")).toBe(field);
  } finally {
    if (ui) await act(async () => ui.renderer.destroy());
    await server.stop();
  }
});
