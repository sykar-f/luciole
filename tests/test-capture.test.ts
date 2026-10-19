import { drive } from "../scripts/pty/driver";
import { rejectionOf } from "./helpers";
import { expect, spyOn, test } from "bun:test";
import { TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { cellOf, clickOn } from "../packages/core/src/test/client";
import * as frames from "../packages/core/src/test/frame";
import { buildApp, openClient, startServer, TEST_TIMEOUT_MS } from "../packages/core/src/test";
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

/** Start another native presentation before a renderOnce caller resumes. */
function overlap(ui: Parameters<typeof renderFrame>[0], change: () => void) {
  const renderOnce = ui.renderOnce;
  let concurrent: Promise<void> | undefined;
  let forced = false;
  ui.renderOnce = async () => {
    await renderOnce();
    if (forced) return;
    forced = true;
    change();
    concurrent = renderOnce();
    expect(ui.renderer.getSchedulerState().isRendering).toBe(true);
  };
  return { finished: () => concurrent, forced: () => forced };
}

test(
  "public client.spans captures during overlapping native presentation",
  async () => {
    const app = await buildApp("examples/notes");
    await using server = await startServer(app, { NOTES_DB: ":memory:" });
    await using client = await openClient(app, server);
    const text = new TextRenderable(client.ui.renderer, { content: "snapshot before" });
    client.ui.renderer.root.add(text);
    const concurrent = overlap(client.ui, () => {
      text.content = "snapshot after";
    });
    try {
      const snapshot = await client.spans();
      expect(concurrent.forced()).toBe(true);
      expect(snapshot.cols).toBe(110);
      expect(snapshot.rows).toBe(32);
      expect(
        snapshot.lines
          .flatMap((line) => line.spans)
          .map((span) => span.text)
          .join(""),
      ).toContain("snapshot");
      const saved = snapshot.lines.map((line) =>
        line.spans.map((span) => ({
          ...span,
          fg: span.fg.toInts(),
          bg: span.bg.toInts(),
        })),
      );
      await concurrent.finished();
      text.content = "another frame";
      await client.spans();
      expect(
        snapshot.lines.map((line) =>
          line.spans.map((span) => ({
            ...span,
            fg: span.fg.toInts(),
            bg: span.bg.toInts(),
          })),
        ),
      ).toEqual(saved);
    } finally {
      await concurrent.finished();
    }
  },
  TEST_TIMEOUT_MS,
);

test("no-act span capture fences overlapping native presentation", async () => {
  const ui = await createTestRenderer({ width: 20, height: 3 });
  const text = new TextRenderable(ui.renderer, { content: "before" });
  ui.renderer.root.add(text);
  const concurrent = overlap(ui, () => {
    text.content = "after";
  });
  try {
    const snapshot = await frames.renderCaptureWithoutAct(ui, ui.captureSpans);
    expect(snapshot.lines[0]?.spans.map((span) => span.text).join("")).toContain("before");
    expect(concurrent.forced()).toBe(true);
    expect(ui.renderer.listenerCount("frame")).toBe(0);
    expect(ui.renderer.listenerCount("render:error")).toBe(0);
  } finally {
    await concurrent.finished();
    await ui.dispose();
  }
});

for (const status of ["failed", "blocked", "stopped"] as const) {
  test(`frame rejects when a ${status} pass neither presents nor schedules`, async () => {
    const ui = await createTestRenderer({ width: 20, height: 3 });
    ui.renderer.root.add(new TextRenderable(ui.renderer, { content: "before" }));
    const presentation = spyOn(ui.renderer.nativeScene, "commit").mockReturnValue(3);
    const log = spyOn(console, "error").mockImplementation(() => {});
    if (status === "blocked") Reflect.set(ui.renderer, "isSplitCursorSeedFrameBlocked", () => true);
    if (status === "stopped") Reflect.set(ui.renderer, "_controlState", "explicit_suspended");
    try {
      const error = await rejectionOf(renderFrame(ui));
      expect(String(error)).toContain("without presenting a frame");
      expect(String(error)).toContain("hasScheduledRender");
      expect(ui.renderer.listenerCount("frame")).toBe(0);
    } finally {
      presentation.mockRestore();
      log.mockRestore();
      await ui.dispose();
    }
  });
}

for (const capture of [
  renderFrame,
  (ui: Parameters<typeof renderFrame>[0]) =>
    frames.renderCaptureWithoutAct(ui, ui.captureCharFrame),
]) {
  test(`${capture.name || "no-act"} preserves an output-idle retry`, async () => {
    const ui = await createTestRenderer({ width: 20, height: 3 });
    ui.renderer.root.add(new TextRenderable(ui.renderer, { content: "retry presented" }));
    const commit = spyOn(ui.renderer.nativeScene, "commit").mockReturnValueOnce(2);
    try {
      expect(await capture(ui)).toContain("retry presented");
      expect(commit.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      commit.mockRestore();
      await ui.dispose();
    }
  });
}

for (const source of ["render", "native", "capture", "destroy"] as const) {
  test(`no-act capture forwards ${source} failure and removes listeners`, async () => {
    const ui = await createTestRenderer({ width: 20, height: 3 });
    ui.renderer.root.add(new TextRenderable(ui.renderer, { content: "before" }));
    const failure = new Error(`${source} failed`);
    const native =
      source === "native"
        ? spyOn(ui.renderer.nativeScene, "commit").mockImplementation(() => {
            throw failure;
          })
        : undefined;
    if (source === "render") ui.renderOnce = () => Promise.reject(failure);
    if (source === "destroy") ui.renderOnce = () => ui.dispose();
    try {
      const result = frames.renderCaptureWithoutAct(ui, () => {
        if (source === "capture") throw failure;
        return ui.captureCharFrame();
      });
      const error = await rejectionOf(result);
      if (source === "destroy") expect(String(error)).toContain("destroyed before presenting");
      else expect(error).toBe(failure);
      expect(ui.renderer.listenerCount("frame")).toBe(0);
      expect(ui.renderer.listenerCount("render:error")).toBe(0);
      expect(ui.renderer.listenerCount("destroy")).toBe(source === "destroy" ? 0 : 1);
    } finally {
      native?.mockRestore();
      await ui.dispose();
    }
  });
}

test("no-act capture preserves native close failure on destruction", async () => {
  const ui = await createTestRenderer({ width: 20, height: 3 });
  const failure = new Error("native sink failed");
  const closed = Promise.withResolvers<void>();
  Object.defineProperty(ui.renderer, "closed", { configurable: true, value: closed.promise });
  ui.renderOnce = async () => {
    ui.renderer.destroy();
    closed.reject(failure);
  };
  try {
    const error = await rejectionOf(frames.renderCaptureWithoutAct(ui, ui.captureSpans));
    expect(error).toBe(failure);
    expect(ui.renderer.listenerCount("frame")).toBe(0);
    expect(ui.renderer.listenerCount("render:error")).toBe(0);
  } finally {
    Reflect.deleteProperty(ui.renderer, "closed");
    await ui.dispose();
  }
});

test("PTY span snapshots retain colors across input and resize refreshes", async () => {
  await using terminal = await drive({
    command: [
      process.execPath,
      "-e",
      String.raw`
      process.stdin.setRawMode(true);
      process.stdout.write("\x1b[?2026h\x1b[H\x1b[38;2;255;0;0mred\x1b[0m\x1b[?2026l");
      process.stdin.on("data", () => {
        process.stdout.write("\x1b[?2026h\x1b[H\x1b[38;2;0;255;0mnew\x1b[0m\x1b[?2026l");
      });
    `,
    ],
    cols: 20,
    rows: 3,
  });
  await terminal.waitFor("red");
  const first = await terminal.spans();
  const red = first[0]?.find((span) => span.text.includes("red"));
  expect(red?.fg).toBe("#ff0000");
  terminal.write("x");
  await terminal.waitFor("new");
  const next = await terminal.spans();
  expect(next[0]?.find((span) => span.text.includes("new"))?.fg).toBe("#00ff00");
  expect(first[0]?.find((span) => span.text.includes("red"))).toEqual(red);
  terminal.resize(30, 4);
  const resized = await terminal.spans();
  expect(resized).toHaveLength(4);
  expect(resized[0]?.map((span) => span.text).join("")).toHaveLength(30);
});
