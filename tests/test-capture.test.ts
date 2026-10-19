import { expect, test } from "bun:test";
import { TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { untilDrawn, untilFrame } from "../packages/core/src/test/wait";

for (const wait of [untilFrame, untilDrawn]) {
  test(`${wait.name} captures a frame while another render presents output`, async () => {
    const ui = await createTestRenderer({ width: 20, height: 3 });
    const text = new TextRenderable(ui.renderer, { content: "before" });
    ui.renderer.root.add(text);
    const renderOnce = ui.renderOnce;
    let concurrent: Promise<void> | undefined;
    let forced = false;
    ui.renderOnce = async () => {
      await renderOnce();
      if (forced) return;
      forced = true;
      text.content = "after";
      // Starts native presentation synchronously, but lets the caller continue
      // before its output pump runs: the same boundary as a render during act.
      concurrent = renderOnce();
      expect(ui.renderer.getSchedulerState().isRendering).toBe(true);
    };
    try {
      expect(await wait(ui, "after")).toContain("after");
      expect(forced).toBe(true);
    } finally {
      await concurrent;
      await ui.dispose();
    }
  });
}

test("native capture refuses a buffer until concurrent presentation ends", async () => {
  const ui = await createTestRenderer({ width: 20, height: 3 });
  const text = new TextRenderable(ui.renderer, { content: "before" });
  ui.renderer.root.add(text);
  try {
    await ui.renderOnce();
    text.content = "after";
    const concurrent = ui.renderOnce();
    try {
      expect(() => ui.captureCharFrame()).toThrow("OutputBusy");
      expect(() => ui.captureSpans()).toThrow("OutputBusy");
    } finally {
      await concurrent;
    }
    expect(ui.captureCharFrame()).toContain("after");
  } finally {
    await ui.dispose();
  }
});
