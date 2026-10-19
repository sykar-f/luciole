import type { PixelFrame } from "./frame";

/** One presented frame plus every publication still in flight. */
export const RETAINED_GENERATIONS = 8;

export class PixelHistory {
  private frames = new Map<number, PixelFrame>();
  private presented = 0;
  presentations = false;

  canPublish(count = 1) {
    return !this.presentations || this.frames.size + count <= RETAINED_GENERATIONS;
  }

  acknowledge(id: number, generation: number) {
    const frame = this.frames.get(generation);
    if (!frame || frame.id !== id || generation <= this.presented) return false;
    this.presented = generation;
    for (const old of this.frames.keys()) if (old < generation) this.frames.delete(old);
    return true;
  }

  add(frame: PixelFrame) {
    if (!this.canPublish()) throw new Error("Pixel presentation window is full");
    this.frames.set(frame.generation, frame);
    // The v1 fallback bounds memory by eviction, without reinterpreting old input.
    while (this.frames.size > RETAINED_GENERATIONS) {
      const oldest = this.frames.keys().next().value;
      if (oldest !== undefined) this.frames.delete(oldest);
    }
  }

  get(id: number, generation: number) {
    const frame = this.frames.get(generation);
    if (!frame || frame.id !== id || generation < this.presented) return;
    // V2 retires only on ordered presentation reports. V1 retains its input rule.
    if (!this.presentations) this.acknowledge(id, generation);
    return frame;
  }

  clear() {
    this.frames.clear();
    this.presented = 0;
  }
}
