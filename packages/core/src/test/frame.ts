import { act } from "react";
import type { TestUI } from "./wait";
import { renderCaptureWithoutAct } from "./capture";

export { renderCaptureWithoutAct } from "./capture";

/** Read a snapshot at native presentation, including renders serviced by React act. */
export function renderCapture<T>(ui: TestUI, capture: () => T): Promise<T> {
  return renderCaptureWithoutAct(ui, capture, () =>
    act(async () => {
      await ui.renderOnce();
    }),
  );
}

/** The screen as text, captured synchronously at the presented-frame boundary. */
export function renderFrame(ui: TestUI): Promise<string> {
  return renderCapture(ui, ui.captureCharFrame);
}

/** A detached frame of text, cell widths, RGBA colors and attributes. */
export type SpanFrame = ReturnType<TestUI["captureSpans"]>;

/** OpenTUI copies span strings, colors and attributes out of its scoped native lease. */
export function renderSpans(ui: TestUI): Promise<SpanFrame> {
  return renderCapture(ui, ui.captureSpans);
}
