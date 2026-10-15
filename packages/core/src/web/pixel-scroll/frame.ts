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
export function planPixelFrame(frame: PixelFrame, release = false): RenderFramePlan {
  const { id, generation, rect, origin, fraction, viewport } = frame;
  if (release && fraction !== 0) throw new Error("A pixel release requires a canonical frame");
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
    after: bytes([register, ...(fraction > 0 ? [] : finish)]),
    onHitMap(map) {
      frame.snapshot = map;
    },
    ...(fraction > 0
      ? {
          projection: {
            ...viewport.project(origin + 1),
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
