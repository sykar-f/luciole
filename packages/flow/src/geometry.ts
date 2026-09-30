/**
 * Where things are on the canvas: flow coordinates (cells at zoom 1) to canvas cells,
 * semantic zoom, node rectangles, handle anchors, fitting the view. Pure functions.
 */
import type {
  Detail,
  HandleSpec,
  HandleType,
  Node,
  Position,
  Rect,
  Viewport,
  XY,
} from "./types.ts";

/** The zoom levels, from closest to farthest. Each draws nodes with less detail. */
const HALF = 0.5;
const QUARTER = 0.25;
export const ZOOMS = [1, HALF, QUARTER] as const;
const DETAILS: readonly Detail[] = ["full", "compact", "dot"];
const FIT_PADDING = 2;
/** A node that was never measured: its label in a bordered box. */
const BORDER_AND_PADDING = 4;
const DEFAULT_HEIGHT = 3;
const MIN_LABEL = 4;

export function detailFor(zoom: number): Detail {
  const index = ZOOMS.findIndex((z) => zoom >= z);
  return DETAILS[index < 0 ? DETAILS.length - 1 : index] ?? "dot";
}

/** The next zoom level in (`+1`) or out (`-1`), or the same one at either end. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  const index = ZOOMS.findIndex((z) => zoom >= z);
  const current = index < 0 ? ZOOMS.length - 1 : index;
  const next = Math.min(ZOOMS.length - 1, Math.max(0, current - direction));
  return ZOOMS[next] ?? zoom;
}

/** Zooms to `zoom` keeping the flow point under canvas cell `anchor` where it is. */
export function zoomAround(viewport: Viewport, zoom: number, anchor: XY): Viewport {
  const flow = toFlow(anchor, viewport);
  return {
    x: Math.round(anchor.x - flow.x * zoom),
    y: Math.round(anchor.y - flow.y * zoom),
    zoom,
  };
}

export const toCanvas = (point: XY, viewport: Viewport): XY => ({
  x: Math.round(point.x * viewport.zoom + viewport.x),
  y: Math.round(point.y * viewport.zoom + viewport.y),
});
export const toFlow = (point: XY, viewport: Viewport): XY => ({
  x: (point.x - viewport.x) / viewport.zoom,
  y: (point.y - viewport.y) / viewport.zoom,
});

export const labelOf = (node: Node) =>
  typeof node.data.label === "string" ? node.data.label : node.id;

/** Where each node is in flow coordinates, its parents' positions added. */
export function absolutePositions(nodes: readonly Node[]): Map<string, XY> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const positions = new Map<string, XY>();
  const resolve = (node: Node, seen: Set<string>): XY => {
    const known = positions.get(node.id);
    if (known) return known;
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    // A cycle of parents is ignored rather than followed.
    const origin =
      parent && !seen.has(parent.id) ? resolve(parent, new Set(seen).add(node.id)) : { x: 0, y: 0 };
    const position = { x: origin.x + node.position.x, y: origin.y + node.position.y };
    positions.set(node.id, position);
    return position;
  };
  for (const node of nodes) resolve(node, new Set([node.id]));
  return positions;
}

export type Size = { width: number; height: number };
/** A rendered size and the detail it was rendered at. */
export type Measured = Size & { detail: Detail };

/** The size a node takes at `detail` before it is measured. */
export function estimateSize(node: Node, detail: Detail, zoom = 1): Size {
  if (node.type === "group" || (node.width !== undefined && node.height !== undefined)) {
    const width = node.width ?? MIN_LABEL;
    const height = node.height ?? DEFAULT_HEIGHT;
    return detail === "full"
      ? { width, height }
      : {
          width: Math.max(2, Math.round(width * zoom)),
          height: Math.max(1, Math.round(height * zoom)),
        };
  }
  const label = Math.max(MIN_LABEL, labelOf(node).length);
  if (detail === "dot") return { width: 1, height: 1 };
  if (detail === "compact") return { width: label + 2, height: 1 };
  return { width: label + BORDER_AND_PADDING, height: DEFAULT_HEIGHT };
}

export type Placed = {
  node: Node;
  /** In canvas cells. */
  rect: Rect;
  /** Drawing order: groups under their children, the selection over the rest. */
  z: number;
};

const GROUP_Z = -1;
const SELECTED_Z = 1000;

/** Each visible node's rectangle on the canvas, in drawing order. */
export function placeNodes(
  nodes: readonly Node[],
  viewport: Viewport,
  measured: ReadonlyMap<string, Measured>,
): Placed[] {
  const detail = detailFor(viewport.zoom);
  const positions = absolutePositions(nodes);
  const placed: Placed[] = [];
  for (const node of nodes) {
    if (node.hidden) continue;
    const at = toCanvas(positions.get(node.id) ?? node.position, viewport);
    const size = measured.get(node.id);
    const { width, height } =
      size && size.detail === detail ? size : estimateSize(node, detail, viewport.zoom);
    const z =
      (node.zIndex ?? 0) + (node.type === "group" ? GROUP_Z : 0) + (node.selected ? SELECTED_Z : 0);
    placed.push({ node, rect: { x: at.x, y: at.y, width, height }, z });
  }
  // Stable: equal z keeps the application's order.
  return placed.sort((a, b) => a.z - b.z);
}

/** The flow-coordinate bounds of `nodes` at full detail, or null when there are none. */
export function flowBounds(
  nodes: readonly Node[],
  measured: ReadonlyMap<string, Measured>,
): Rect | null {
  const positions = absolutePositions(nodes);
  let bounds: { x0: number; y0: number; x1: number; y1: number } | null = null;
  for (const node of nodes) {
    if (node.hidden) continue;
    const at = positions.get(node.id) ?? node.position;
    const size = measured.get(node.id);
    const { width, height } = size?.detail === "full" ? size : estimateSize(node, "full");
    const box = { x0: at.x, y0: at.y, x1: at.x + width, y1: at.y + height };
    bounds = bounds
      ? {
          x0: Math.min(bounds.x0, box.x0),
          y0: Math.min(bounds.y0, box.y0),
          x1: Math.max(bounds.x1, box.x1),
          y1: Math.max(bounds.y1, box.y1),
        }
      : box;
  }
  return (
    bounds && {
      x: bounds.x0,
      y: bounds.y0,
      width: bounds.x1 - bounds.x0,
      height: bounds.y1 - bounds.y0,
    }
  );
}

/** The closest zoom level at which `bounds` fits `canvas`, centered. */
export function fitViewport(bounds: Rect | null, canvas: Size, padding = FIT_PADDING): Viewport {
  if (!bounds) return { x: padding, y: padding, zoom: 1 };
  const zoom =
    ZOOMS.find(
      (z) =>
        bounds.width * z <= canvas.width - padding * 2 &&
        bounds.height * z <= canvas.height - padding * 2,
    ) ?? ZOOMS[ZOOMS.length - 1];
  const z = zoom ?? 1;
  return {
    x: Math.round((canvas.width - bounds.width * z) / 2 - bounds.x * z),
    y: Math.round((canvas.height - bounds.height * z) / 2 - bounds.y * z),
    zoom: z,
  };
}

/** The smallest pan that brings `rect` (canvas cells) into `canvas`, `margin` cells in. */
export function panToShow(viewport: Viewport, rect: Rect, canvas: Size, margin = 1): Viewport {
  const shift = (start: number, length: number, size: number) => {
    if (length + margin * 2 > size) return -start + margin;
    if (start < margin) return margin - start;
    if (start + length > size - margin) return size - margin - (start + length);
    return 0;
  };
  const dx = shift(rect.x, rect.width, canvas.width);
  const dy = shift(rect.y, rect.height, canvas.height);
  return dx === 0 && dy === 0 ? viewport : { ...viewport, x: viewport.x + dx, y: viewport.y + dy };
}

export const contains = (rect: Rect, point: XY) =>
  point.x >= rect.x &&
  point.x < rect.x + rect.width &&
  point.y >= rect.y &&
  point.y < rect.y + rect.height;

export type Anchor = {
  nodeId: string;
  handle: string | null;
  type: HandleType;
  position: Position;
  /** The cell just outside the node's border, where the edge starts or ends. */
  cell: XY;
};

/**
 * Each handle's anchor cell: `handles` as the node declared them, or one source and one
 * target on the node's `sourcePosition`/`targetPosition`. Handles sharing a side are
 * spread along it.
 */
export function anchorsOf(
  placed: Placed,
  handles: readonly HandleSpec[] | undefined,
  detail: Detail,
): Anchor[] {
  const { node, rect } = placed;
  const specs: readonly HandleSpec[] =
    handles && handles.length > 0
      ? handles
      : [
          ...(node.type === "input" || node.type === "group"
            ? []
            : [{ id: null, type: "target" as const, position: node.targetPosition ?? "left" }]),
          ...(node.type === "output" || node.type === "group"
            ? []
            : [{ id: null, type: "source" as const, position: node.sourcePosition ?? "right" }]),
        ];
  // At `dot` the node is one cell: every handle is on it, whatever its side.
  const bySide = new Map<Position, HandleSpec[]>();
  for (const spec of specs) bySide.set(spec.position, [...(bySide.get(spec.position) ?? []), spec]);
  const anchors: Anchor[] = [];
  for (const [position, list] of bySide)
    list.forEach((spec, index) => {
      const along = (length: number) =>
        detail === "dot" ? 0 : Math.floor(((index + 1) * length) / (list.length + 1) - 1 / 2);
      const midX = rect.x + Math.max(0, Math.min(rect.width - 1, along(rect.width)));
      const midY = rect.y + Math.max(0, Math.min(rect.height - 1, along(rect.height)));
      const cell =
        position === "left"
          ? { x: rect.x - 1, y: midY }
          : position === "right"
            ? { x: rect.x + rect.width, y: midY }
            : position === "top"
              ? { x: midX, y: rect.y - 1 }
              : { x: midX, y: rect.y + rect.height };
      anchors.push({ nodeId: node.id, handle: spec.id, type: spec.type, position, cell });
    });
  return anchors;
}

/** The anchor an edge uses at one end: its named handle, else the first of that type. */
export function pickAnchor(
  anchors: readonly Anchor[],
  type: HandleType,
  handle: string | null | undefined,
): Anchor | undefined {
  const ofType = anchors.filter((a) => a.type === type);
  return (handle ? ofType.find((a) => a.handle === handle) : undefined) ?? ofType[0];
}

export const opposite: Record<Position, Position> = {
  left: "right",
  right: "left",
  top: "bottom",
  bottom: "top",
};
