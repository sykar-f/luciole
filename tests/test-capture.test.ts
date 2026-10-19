import { expect, test } from "bun:test";
import { TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { cellOf, clickOn } from "../packages/core/src/test/client";
import { renderFrame } from "../packages/core/src/test/frame";
import { untilDrawn, untilFrame } from "../packages/core/src/test/wait";

const captures = [
  {
    name: "untilFrame",
    capture: (ui: Parameters<typeof untilFrame>[0]) => untilFrame(ui, "before"),
  },
  {
    name: "untilDrawn",
    capture: (ui: Parameters<typeof untilFrame>[0]) => untilDrawn(ui, "before"),
  },
  { name: "frame", capture: renderFrame },
  {
    name: "cellOf",
    capture: async (ui: Parameters<typeof untilFrame>[0]) => {
      expect(await cellOf(ui, "before")).toEqual({ x: 0, y: 0 });
      return "before";
    },
  },
  {
    name: "clickOn",
    capture: async (ui: Parameters<typeof untilFrame>[0]) => {
      await clickOn(ui, "before");
      return "before";
    },
  },
];
for (const { name, capture } of captures) {
  test(`${name} captures a frame while another render presents output`, async () => {
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
      text.content = "before after";
      // Starts native presentation synchronously, but lets the caller continue
      // before its output pump runs: the same boundary as a render during act.
      concurrent = renderOnce();
      expect(ui.renderer.getSchedulerState().isRendering).toBe(true);
    };
    try {
      expect(await capture(ui)).toContain("before");
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

test("frame returns the latest presentation when rendering was already active", async () => {
  const ui = await createTestRenderer({ width: 20, height: 3 });
  const text = new TextRenderable(ui.renderer, { content: "before" });
  ui.renderer.root.add(text);
  const active = ui.renderOnce();
  text.content = "after";
  try {
    expect(await renderFrame(ui)).toContain("after");
  } finally {
    await active;
    await ui.dispose();
  }
});

test("frame captures an animated renderer without waiting for it to stop", async () => {
  const ui = await createTestRenderer({ width: 20, height: 3 });
  ui.renderer.root.add(new TextRenderable(ui.renderer, { content: "animated" }));
  ui.renderer.start();
  try {
    expect(await renderFrame(ui)).toContain("animated");
    expect(ui.renderer.isRunning).toBe(true);
    expect(ui.renderer.listenerCount("frame")).toBe(0);
  } finally {
    await ui.dispose();
  }
});

test("frame propagates a later capture failure after an earlier frame succeeded", async () => {
  const ui = await createTestRenderer({ width: 20, height: 3 });
  ui.renderer.root.add(new TextRenderable(ui.renderer, { content: "before" }));
  const active = ui.renderOnce();
  const capture = ui.captureCharFrame;
  const failure = new Error("capture failed");
  let calls = 0;
  ui.captureCharFrame = () => {
    if (++calls === 2) throw failure;
    return capture();
  };
  try {
    let rejected: unknown;
    try {
      await renderFrame(ui);
    } catch (error) {
      rejected = error;
    }
    expect(calls).toBe(2);
    expect(rejected).toBe(failure);
    expect(ui.renderer.listenerCount("frame")).toBe(0);
  } finally {
    await active;
    await ui.dispose();
  }
});
