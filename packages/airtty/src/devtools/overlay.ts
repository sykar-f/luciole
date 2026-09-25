import { RGBA, type CliRenderer, type OptimizedBuffer } from "@opentui/core";
import type { Rendered } from "./fibers";

/**
 * Paint flashing in the inspected terminal, like Chrome's "Paint flashing" or react-scan:
 * each component that rendered is outlined for a moment, drawn over the frame by a
 * post-process function, so the application's layout never changes. Outlines, not fills:
 * a terminal cell has one character, and a flash must not hide what it flags.
 */
const FLASH_MS = 600;
const FADE_AT = 0.5;
type Rect = NonNullable<Rendered["rect"]>;
type Flash = { rect: Rect; color: string; until: number };
const COLOR = {
  unnecessary: ["#ff5f5f", "#8a3a3a"],
  once: ["#67d9bc", "#2f6b5c"],
  often: ["#f0c060", "#7a6431"],
  hot: ["#ff8c42", "#7f4822"],
  selected: "#5fafff",
} as const;
const HOT_RENDERS = 5,
  OFTEN_RENDERS = 2;
const heat = (flash: Rendered) =>
  flash.unnecessary
    ? COLOR.unnecessary
    : flash.renders >= HOT_RENDERS
      ? COLOR.hot
      : flash.renders >= OFTEN_RENDERS
        ? COLOR.often
        : COLOR.once;
const transparent = RGBA.fromValues(0, 0, 0, 0);

export function createOverlay(renderer: CliRenderer) {
  let flashes: Flash[] = [];
  let enabled = false;
  let unnecessaryOnly = false;
  let selected: Rect | undefined;
  let live = false;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const outline = (buffer: OptimizedBuffer, rect: Rect, color: string) => {
    // A one-line element gets a box around it rather than over it, clipped to the screen.
    const thin = rect.height < 2 || rect.width < 2;
    const x = Math.max(0, thin ? rect.x - 1 : rect.x);
    const y = Math.max(0, thin ? rect.y - 1 : rect.y);
    const width = Math.min(buffer.width - x, thin ? rect.width + 2 : rect.width);
    const height = Math.min(buffer.height - y, thin ? rect.height + 2 : rect.height);
    if (width < 2 || height < 2) return;
    buffer.drawBox({
      x,
      y,
      width,
      height,
      border: true,
      borderColor: RGBA.fromHex(color),
      backgroundColor: transparent,
      shouldFill: false,
    });
  };
  const draw = (buffer: OptimizedBuffer) => {
    const now = performance.now();
    flashes = flashes.filter((f) => f.until > now);
    for (const flash of flashes) outline(buffer, flash.rect, flash.color);
    if (selected) outline(buffer, selected, COLOR.selected);
  };
  renderer.addPostProcessFn(draw);
  // Frames keep coming while a flash fades; the renderer idles again once all are gone.
  const keepAlive = () => {
    if (!live) {
      live = true;
      renderer.requestLive();
    }
    clearTimeout(expiry);
    expiry = setTimeout(() => {
      live = false;
      renderer.dropLive();
      renderer.requestRender();
    }, FLASH_MS);
  };
  return {
    configure(next: { enabled: boolean; unnecessaryOnly?: boolean }) {
      enabled = next.enabled;
      unnecessaryOnly = next.unnecessaryOnly ?? false;
      if (!enabled) flashes = [];
      renderer.requestRender();
    },
    flash(rendered: readonly Rendered[]) {
      if (!enabled) return;
      const now = performance.now();
      for (const item of rendered) {
        if (!item.rect || (unnecessaryOnly && !item.unnecessary)) continue;
        const [bright, dim] = heat(item);
        const until = now + FLASH_MS;
        // Drawn in order: the bright outline covers the dim one until it expires.
        flashes.push({ rect: item.rect, color: dim, until });
        flashes.push({ rect: item.rect, color: bright, until: now + FLASH_MS * FADE_AT });
      }
      if (flashes.length) keepAlive();
    },
    select(rect: Rect | undefined) {
      selected = rect;
      renderer.requestRender();
    },
    dispose() {
      renderer.removePostProcessFn(draw);
      clearTimeout(expiry);
      if (live) renderer.dropLive();
    },
  };
}
