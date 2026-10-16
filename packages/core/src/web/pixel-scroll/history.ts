import type { PixelFrame } from "./frame";

/** Input reports are the only generation acknowledgements in contract v1. */
export const RETAINED_GENERATIONS = 8;

export class PixelHistory {
  private frames = new Map<number, PixelFrame>();
  private presented = 0;

  add(frame: PixelFrame) {
    this.frames.set(frame.generation, frame);
    // Bound memory even when there is no input. Old input is rejected, never rebased
    // onto a newer frame. Eight frames allow ordinary parser/presentation lag.
    while (this.frames.size > RETAINED_GENERATIONS) {
      const oldest = this.frames.keys().next().value;
      if (oldest !== undefined) this.frames.delete(oldest);
    }
  }

  get(id: number, generation: number) {
    const frame = this.frames.get(generation);
    if (!frame || frame.id !== id || generation < this.presented) {
      console.debug(
        "[DEBUG-editor-press-history]",
        JSON.stringify({
          id,
          generation,
          presented: this.presented,
          retained: [...this.frames.keys()],
          found: !!frame,
        }),
      );
      return;
    }
    this.presented = generation;
    // Ordered input proves older presentations can no longer produce new input.
    for (const old of this.frames.keys()) if (old < generation) this.frames.delete(old);
    return frame;
  }

  clear() {
    this.frames.clear();
    this.presented = 0;
  }
}
