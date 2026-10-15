/** Optional capabilities supplied by our source patch, absent from npm OpenTUI. */
import type { CliRenderer, RawMouseEvent, Renderable } from "@opentui/core";

export interface RenderHitMap {
  readonly width: number;
  readonly height: number;
  readonly frameId: number;
  readonly passId: number;
  hitTest(x: number, y: number): number;
  origin(id: number): Readonly<{ x: number; y: number }> | undefined;
}

export interface RenderFrameSegment {
  /** Opaque terminal bytes; synchronized-output controls belong to the encoder. */
  before?: Uint8Array;
  after?: Uint8Array;
  onHitMap?: (map: RenderHitMap) => void;
}

export interface RenderFramePlan extends RenderFrameSegment {
  /** Replace this content node's paint translation for a second pass. */
  projection?: RenderFrameSegment & {
    renderable: Renderable;
    translateX: number;
    translateY: number;
  };
}

export type PresentedMouseEvent = RawMouseEvent & {
  modifiers: RawMouseEvent["modifiers"] & { meta?: boolean };
};

export interface OpenTuiSeams {
  setFramePlan(plan: (() => RenderFramePlan | null) | null): void;
  captureHitMap(): RenderHitMap;
  dispatchMouseEventFromHitMap(event: PresentedMouseEvent, map: RenderHitMap): boolean;
}

const METHODS = ["setFramePlan", "captureHitMap", "dispatchMouseEventFromHitMap"] as const;
export type OpenTuiSeamDetection =
  | { available: true; renderer: CliRenderer & OpenTuiSeams }
  | { available: false; missing: readonly (typeof METHODS)[number][] };

function hasMethod(renderer: unknown, name: (typeof METHODS)[number]): boolean {
  if (typeof renderer !== "object" || renderer === null) return false;
  const method: unknown = Reflect.get(renderer, name);
  return typeof method === "function";
}

function hasSeams(renderer: unknown): renderer is CliRenderer & OpenTuiSeams {
  return METHODS.every((name) => hasMethod(renderer, name));
}

/** Report missing capabilities so callers can choose the ordinary native path. */
export function detectOpenTuiSeams(renderer: unknown): OpenTuiSeamDetection {
  return hasSeams(renderer)
    ? { available: true, renderer }
    : { available: false, missing: METHODS.filter((name) => !hasMethod(renderer, name)) };
}
