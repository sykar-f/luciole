import { encode, VERSION, type PixelOperation, type Rect } from "../../pixel-scroll/protocol";
import type { RenderFramePlan, RenderHitMap, ScrollableViewport } from "../opentui-seams";

export interface PixelFrame {
  readonly id: number;
  readonly generation: number;
  readonly viewport: ScrollableViewport;
  readonly rect: Rect;
  readonly origin: number;
  readonly fraction: number;
  snapshot?: RenderHitMap;
  projection?: RenderHitMap;
}

const bytes = (operations: PixelOperation[]) =>
  new TextEncoder().encode(operations.map(encode).join(""));

/** One immutable logical presentation; no cell metrics or pixel quantization here. */
export function planPixelFrame(
  frame: PixelFrame,
  release = false,
  canonicalRepaint = false,
): RenderFramePlan {
  const { id, generation, rect, origin, fraction, viewport } = frame;
  if (release && fraction !== 0) throw new Error("A pixel release requires a canonical frame");
  const project = fraction > 0 || canonicalRepaint;
  const finish: PixelOperation[] = [
    { op: "step", version: VERSION, id, generation, fraction },
    { op: "commit", version: VERSION, generation },
  ];
  if (release) finish.push({ op: "release", version: VERSION, id, generation });
  const register: PixelOperation = {
    op: "register",
    version: VERSION,
    id,
    generation,
    rect,
    origin,
  };
  return {
    before: bytes([{ op: "begin", version: VERSION, generation }]),
    after: bytes([register, ...(project ? [] : finish)]),
    onHitMap(map) {
      frame.snapshot = map;
    },
    ...(project
      ? {
          projection: {
            ...viewport.project(origin + (fraction > 0 ? 1 : 0)),
            after: bytes(finish),
            onHitMap(map: RenderHitMap) {
              frame.projection = map;
            },
          },
        }
      : {}),
  };
}

/** The host's phase names visible source rows, including the entering bottom edge. */
export function pixelHitSource(frame: PixelFrame, x: number, y: number, phase: number) {
  const { rect } = frame;
  const inside = x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
  const entering = inside && Math.floor(y - rect.y + phase) >= rect.height;
  return {
    map: entering ? frame.projection : frame.snapshot,
    x,
    y: inside ? y + phase - (entering ? 1 : 0) : y,
  };
}

/** A painter that is itself the hit target has no translated document child.
 * Preserve the source document row when its live integer origin has moved.
 * Child targets already carry that movement in their captured node geometry.
 */
export function pixelPointerMap(frame: PixelFrame, map: RenderHitMap): RenderHitMap {
  const delta = frame.viewport.origin - frame.origin;
  if (!delta) return map;
  return {
    width: map.width,
    height: map.height,
    frameId: map.frameId,
    passId: map.passId,
    hitTest: (x, y) => map.hitTest(x, y),
    origin(id) {
      const origin = map.origin(id);
      return origin && id === frame.viewport.owner.num
        ? { x: origin.x, y: origin.y + delta }
        : origin;
    },
  };
}

/** Grid clipping excludes ancestor chrome and any content outside the terminal. */
export function clipPixelRect(rect: Rect, clips: readonly Rect[]): Rect | undefined {
  let { x, y } = rect;
  let right = x + rect.width;
  let bottom = y + rect.height;
  for (const clip of clips) {
    x = Math.max(x, clip.x);
    y = Math.max(y, clip.y);
    right = Math.min(right, clip.x + clip.width);
    bottom = Math.min(bottom, clip.y + clip.height);
  }
  x = Math.ceil(x);
  y = Math.ceil(y);
  right = Math.floor(right);
  bottom = Math.floor(bottom);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : undefined;
}
