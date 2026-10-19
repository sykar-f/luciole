import type { TestRendererSetup } from "@opentui/core/testing";

/** The non-React portion of a test UI, also available in production browser probes. */
type CaptureUI = Pick<TestRendererSetup, "renderer" | "renderOnce">;

/**
 * Capture synchronously after native presentation, before another render can begin.
 * Register before triggering rendering. The optional trigger lets the React adapter
 * own its act scope without importing React into browser or PTY callers.
 */
export async function renderCaptureWithoutAct<T>(
  ui: CaptureUI,
  read: () => T,
  render: () => PromiseLike<void> = ui.renderOnce,
): Promise<T> {
  const { renderer } = ui;
  if (renderer.isDestroyed) throw new Error("Renderer is destroyed");
  const frame = Promise.withResolvers<void>();
  let captured: { value: T } | undefined;
  let failure: { error: unknown } | undefined;
  const fail = (error: unknown) => {
    failure ??= { error };
    frame.reject(error);
  };
  const capture = () => {
    try {
      captured = { value: read() };
      frame.resolve();
    } catch (error) {
      fail(error);
    }
  };
  const destroyed = () => {
    // closed carries native shutdown errors; preserve those over the generic diagnostic.
    renderer.closed.then(
      () => fail(new Error("Renderer destroyed before presenting a frame")),
      fail,
    );
  };
  const failed = ({ error }: { error: Error }) => fail(error);
  const noFrame = () => {
    if (!captured) {
      fail(
        new Error(
          `Renderer completed without presenting a frame: ${JSON.stringify(renderer.getSchedulerState())}`,
        ),
      );
    }
  };
  renderer.on("frame", capture);
  renderer.once("render:error", failed);
  renderer.once("destroy", destroyed);
  try {
    const rendered = Promise.resolve(render()).then(async () => {
      if (captured || failure) return;
      const state = renderer.getSchedulerState();
      if (!state.isRendering && !state.hasScheduledRender) {
        noFrame();
        return;
      }
      // Output-idle retries count as scheduled work. Idle only wins when that
      // work ends without a frame; an animated renderer can satisfy frame first.
      await Promise.race([frame.promise, renderer.idle().then(noFrame)]);
    });
    await Promise.all([frame.promise, rendered]);
    if (failure) throw failure.error;
    if (!captured) throw new Error("Renderer did not capture a frame");
    return captured.value;
  } finally {
    renderer.off("frame", capture);
    renderer.off("destroy", destroyed);
    renderer.off("render:error", failed);
  }
}
