import { encode, VERSION, type PixelOperation, type Rect } from "../../pixel-scroll/protocol";
import {
  detectScrollableViewport,
  type RenderFramePlan,
  type RenderHitMap,
  type ScrollableViewport,
} from "../opentui-seams";

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
  // Capture input bounds before the projection temporarily translates the owner.
  const hitRect = painterHitBounds(viewport);
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
      frame.snapshot = painterHitMap(viewport, map, hitRect);
    },
    ...(project
      ? {
          projection: {
            ...viewport.project(origin + (fraction > 0 ? 1 : 0)),
            after: bytes(finish),
            onHitMap(map: RenderHitMap) {
              frame.projection = painterHitMap(viewport, map, hitRect);
            },
          },
        }
      : {}),
  };
}

/** Painted owner bounds govern input, independently of the translated surface. */
function painterHitBounds(viewport: ScrollableViewport): Rect | undefined {
  if (typeof viewport.input !== "function") return;
  const { owner } = viewport;
  const clips: Rect[] = [];
  for (let parent = owner.parent; parent; parent = parent.parent) {
    const ancestor = detectScrollableViewport(parent);
    if (ancestor) clips.push(ancestor.rect);
  }
  return clipPixelRect(
    { x: owner.screenX, y: owner.screenY, width: owner.width, height: owner.height },
    clips,
  );
}

/** OpenTUI omits the captured drag source so native drops can hit beneath it.
 * A painter still owns its visible document cells in a presented snapshot.
 * Capture that ownership and geometry now, rather than consulting live state
 * after release. Foreign overlays and child hit targets keep their identities.
 */
export function painterHitMap(
  viewport: ScrollableViewport,
  map: RenderHitMap,
  rect = painterHitBounds(viewport),
): RenderHitMap {
  if (typeof viewport.input !== "function" || !rect) return map;
  const owner = viewport.owner;
  const id = owner.num;
  const beneath = new Set([0]);
  for (let parent = owner.parent; parent; parent = parent.parent) beneath.add(parent.num);
  const origin = map.origin(id) ?? Object.freeze({ x: owner.x, y: owner.y });
  const clipped = clipPixelRect(rect, [{ x: 0, y: 0, width: map.width, height: map.height }]);
  if (!clipped) return map;
  const { x, y, width, height } = clipped;
  return Object.freeze({
    width: map.width,
    height: map.height,
    frameId: map.frameId,
    passId: map.passId,
    hitTest(px: number, py: number) {
      const hit = map.hitTest(px, py);
      return beneath.has(hit) && px >= x && px < x + width && py >= y && py < y + height ? id : hit;
    },
    origin: (target: number) => (target === id ? origin : map.origin(target)),
  });
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
