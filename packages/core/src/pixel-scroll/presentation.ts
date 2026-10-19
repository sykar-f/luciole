import type { Rect } from "./protocol";

export type Presentation = {
  id: number;
  generation: number;
  rect: Rect;
  origin: number;
  fraction: number;
  phase: number;
};

/** Renderer-owned checkpoint resources. No xterm private fields cross this seam. */
export interface PixelRenderer {
  readonly cellHeight: number;
  begin(): void;
  capture(rect: Rect): void;
  commit(presentation: Presentation): void;
  release(): boolean;
  abort(): void;
  invalidate(): void;
  onInvalidate(listener: () => void): { dispose(): void };
  onPresent(listener: (presentation: Presentation | undefined, released?: Presentation) => void): {
    dispose(): void;
  };
}
