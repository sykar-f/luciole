import { act } from "react";
import type { TestUI } from "./wait";

/**
 * Read the buffer synchronously at the presented-frame boundary. Awaiting renderOnce
 * inside act leaves a gap: act can service another render before its caller resumes,
 * and that render's pending native output prevents acquiring a buffer lease.
 * The frame event runs after presentation, while the renderer still excludes a new
 * render. Capturing here also works when animation keeps the renderer running.
 */
export async function renderFrame(ui: TestUI): Promise<string> {
  if (ui.renderer.isDestroyed) throw new Error("Renderer is destroyed");
  const frame = Promise.withResolvers<void>();
  let captured = "";
  let failure: { error: unknown } | undefined;
  const fail = (error: unknown) => {
    failure ??= { error };
    frame.reject(error);
  };
  const capture = () => {
    try {
      captured = ui.captureCharFrame();
      frame.resolve();
    } catch (error) {
      fail(error);
    }
  };
  const destroyed = () => fail(new Error("Renderer destroyed before presenting a frame"));
  const failed = ({ error }: { error: Error }) => fail(error);
  ui.renderer.on("frame", capture);
  ui.renderer.once("render:error", failed);
  ui.renderer.once("destroy", destroyed);
  try {
    // Attach the rejection handler before act can service renderer events.
    const rendered = act(async () => {
      await ui.renderOnce();
    });
    await Promise.all([frame.promise, rendered]);
    if (failure) throw failure.error;
    return captured;
  } finally {
    ui.renderer.off("frame", capture);
    ui.renderer.off("destroy", destroyed);
    ui.renderer.off("render:error", failed);
  }
}
