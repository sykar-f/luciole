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
  /** Precise deltas are already normalized to rows and must bypass wheel acceleration. */
  scroll?: NonNullable<RawMouseEvent["scroll"]> & { precise?: boolean };
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

/** A vertical content surface supplied by patched OpenTUI or an application painter. */
export interface ScrollableViewport {
  readonly owner: Renderable;
  /** Logical rows, including the fraction. */
  readonly position: number;
  /** Integer origin used by ordinary layout and input. */
  readonly origin: number;
  readonly max: number;
  /** Content only; fixed chrome and scrollbars are excluded. */
  readonly rect: Readonly<{ x: number; y: number; width: number; height: number }>;
  set(position: number): void;
  /** Consume rows without acceleration and return the remainder at a bound. */
  scroll(delta: number): number;
  /** A second-pass descriptor; creating it never mutates state or requests paint. */
  project(origin: number): NonNullable<RenderFramePlan["projection"]>;
}

/** Optional on npm OpenTUI; painters may implement the same structural capability. */
function isScrollableViewport(viewport: unknown): viewport is ScrollableViewport {
  if (typeof viewport !== "object" || viewport === null) return false;
  if (
    !["set", "scroll", "project"].every((name) => typeof Reflect.get(viewport, name) === "function")
  )
    return false;
  if (!["position", "origin", "max"].every((name) => Number.isFinite(Reflect.get(viewport, name))))
    return false;
  const rect: unknown = Reflect.get(viewport, "rect");
  if (typeof rect !== "object" || rect === null) return false;
  if (!["x", "y", "width", "height"].every((name) => Number.isFinite(Reflect.get(rect, name))))
    return false;
  return true;
}

export function detectScrollableViewport(value: unknown): ScrollableViewport | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const viewport: unknown = Reflect.get(value, "scrollableViewport");
  return isScrollableViewport(viewport) ? viewport : undefined;
}
