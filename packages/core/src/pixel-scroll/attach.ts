import type { CliRenderer } from "@opentui/core";
import { PixelController } from "./controller";

export interface PixelScrollOptions {
  pixelScroll?: boolean;
  settle?: boolean;
  /** The host preserves command order, including admission under output pressure. */
  write(commands: string): void | Promise<void>;
  /** Observe ordinary SGR input before dispatch, without consuming it. */
  observeOrdinary?(receive: (sequence: string) => void): () => void;
}

/** Attach the shared controller when the renderer supplies the pixel seams. */
export function attachPixelScroll(renderer: CliRenderer, options: PixelScrollOptions) {
  const controller = PixelController.attach(
    renderer,
    (commands) => options.write(commands),
    options,
  );
  if (!controller) return;
  const ordinary = (sequence: string) => controller.ordinary(sequence);
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    renderer.off("destroy", dispose);
    unsubscribe?.();
    controller.dispose();
  };
  renderer.on("destroy", dispose);
  unsubscribe = options.observeOrdinary?.(ordinary);
  return { ordinary, dispose };
}
