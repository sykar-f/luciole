/**
 * One frame of the canvas under its nodes: edges, labels, markers, handles, the
 * connection being made and the background, composed into a grid. And the reverse: what
 * is at a canvas cell. Pure, so that a frame can be printed and compared in tests.
 */
import {
  anchorsOf,
  contains,
  detailFor,
  pickAnchor,
  placeNodes,
  type Anchor,
  type Measured,
  type Placed,
  type Size,
} from "./geometry";
import {
  drawBackground,
  drawEdge,
  drawLabel,
  Grid,
  type BackgroundVariant,
  type EdgeDraw,
  type EdgeStyle,
} from "./raster";
import type { Edge, HandleSpec, Node, Position, Viewport, XY } from "./types";

/**
 * A custom edge type: the corner points of its path from the source anchor cell to the
 * target's, drawn with box characters like a step edge.
 */
export type EdgeRoute = (params: {
  edge: Edge;
  source: XY;
  sourcePosition: Position;
  target: XY;
  targetPosition: Position;
}) => XY[];
/** An edge type: a built-in style, or a route. */
export type EdgeType = EdgeStyle | EdgeRoute;

const BUILTIN_STYLES: ReadonlySet<string> = new Set(["smoothstep", "step", "straight", "bezier"]);
export const CONNECTION_ID = "__connection";
const SOURCE_HANDLE = "●";
const TARGET_HANDLE = "○";

export type FrameInput = {
  size: Size;
  viewport: Viewport;
  nodes: readonly Node[];
  edges: readonly Edge[];
  measured: ReadonlyMap<string, Measured>;
  handles?: ReadonlyMap<string, ReadonlyMap<string, HandleSpec>>;
  background?: { variant: BackgroundVariant; gap: XY } | null;
  connecting?: { source: Anchor; pointer?: XY; target?: string } | null;
  edgeTypes?: Readonly<Record<string, EdgeType>>;
  defaultEdgeType?: string;
  /** Curves and slanted lines in braille; without, they are drawn as smoothstep edges. */
  braille?: boolean;
  /** Animation step: advances the dashes of animated edges. */
  phase?: number;
};

export type Frame = {
  grid: Grid;
  placed: Placed[];
  anchors: Map<string, Anchor[]>;
};

export function composeFrame(input: FrameInput): Frame {
  const detail = detailFor(input.viewport.zoom);
  const placed = placeNodes(input.nodes, input.viewport, input.measured);
  const anchors = new Map(
    placed.map((p) => [
      p.node.id,
      anchorsOf(p, [...(input.handles?.get(p.node.id)?.values() ?? [])], detail),
    ]),
  );
  const grid = new Grid(input.size.width, input.size.height);
  const labels: { at: XY; text: string; owner: string }[] = [];

  // Selected edges last: their color wins where lines share a cell.
  const rank = (e: Edge) => (e.selected ? 2 : e.animated ? 1 : 0);
  const edges = [...input.edges].filter((e) => !e.hidden).sort((a, b) => rank(a) - rank(b));
  for (const edge of edges) {
    const source = pickAnchor(anchors.get(edge.source) ?? [], "source", edge.sourceHandle);
    const target = pickAnchor(anchors.get(edge.target) ?? [], "target", edge.targetHandle);
    if (!source || !target) continue;
    const draw = edgeDraw(edge, source, target, input);
    const at = drawEdge(grid, draw);
    if (edge.label) labels.push({ at, text: edge.label, owner: edge.id });
  }

  const connecting = input.connecting;
  if (connecting) {
    const target = connecting.target
      ? pickAnchor(anchors.get(connecting.target) ?? [], "target", null)
      : undefined;
    const pointer = connecting.pointer;
    const end = target?.cell ?? pointer;
    if (end) {
      const targetPosition: Position =
        target?.position ?? (end.x >= connecting.source.cell.x ? "left" : "right");
      drawEdge(grid, {
        id: CONNECTION_ID,
        style: "smoothstep",
        source: connecting.source.cell,
        sourcePosition: connecting.source.position,
        target: end,
        targetPosition,
        role: "handle",
      });
    }
    // Where it can end: every other node's targets.
    for (const [id, list] of anchors)
      if (id !== connecting.source.nodeId)
        for (const a of list)
          if (a.type === "target" && !(target && a === target))
            grid.set(a.cell.x, a.cell.y, { char: TARGET_HANDLE, role: "handle" });
  }
  // The selected nodes' sources: where a connection starts with the mouse.
  for (const p of placed)
    if (p.node.selected && p.node.connectable !== false)
      for (const a of anchors.get(p.node.id) ?? [])
        if (a.type === "source" && !grid.get(a.cell.x, a.cell.y))
          grid.set(a.cell.x, a.cell.y, { char: SOURCE_HANDLE, role: "handle" });

  for (const label of labels) drawLabel(grid, label.at, label.text, label.owner);
  grid.resolve(input.phase ?? 0);
  if (input.background)
    drawBackground(grid, input.viewport, input.background.variant, input.background.gap);
  return { grid, placed, anchors };
}

function edgeDraw(edge: Edge, source: Anchor, target: Anchor, input: FrameInput): EdgeDraw {
  const name = edge.type ?? input.defaultEdgeType ?? "smoothstep";
  const type = input.edgeTypes?.[name] ?? (BUILTIN_STYLES.has(name) ? name : "smoothstep");
  const base = {
    id: edge.id,
    source: source.cell,
    sourcePosition: source.position,
    target: target.cell,
    targetPosition: target.position,
    label: edge.label,
    animated: edge.animated,
    selected: edge.selected,
    markerEnd: edge.markerEnd !== "none",
    markerStart: edge.markerStart === "arrow",
    color: edge.color,
  };
  if (typeof type === "function")
    return { ...base, style: "step", points: type({ edge, ...base }) };
  const style: EdgeStyle =
    type === "smoothstep" || type === "step" || type === "straight" || type === "bezier"
      ? type
      : "smoothstep";
  // Without braille, curves fall back to the orthogonal path.
  const curved = style === "bezier" || style === "straight";
  return { ...base, style: curved && input.braille === false ? "smoothstep" : style };
}

export type Hit =
  | { kind: "handle"; anchor: Anchor }
  | { kind: "node"; node: Node }
  | { kind: "edge"; id: string }
  | { kind: "pane" };

/** What is at canvas cell `at`: a source handle, a node (topmost first), an edge, or none. */
export function hitTest(frame: Frame, at: XY): Hit {
  for (const list of frame.anchors.values())
    for (const anchor of list)
      if (anchor.type === "source" && anchor.cell.x === at.x && anchor.cell.y === at.y) {
        const node = frame.placed.find((p) => p.node.id === anchor.nodeId)?.node;
        if (node?.connectable !== false) return { kind: "handle", anchor };
      }
  for (let i = frame.placed.length - 1; i >= 0; i--) {
    const p = frame.placed[i];
    if (p && contains(p.rect, at)) return { kind: "node", node: p.node };
  }
  const owner = frame.grid.get(at.x, at.y)?.owner;
  if (owner && owner !== CONNECTION_ID) return { kind: "edge", id: owner };
  return { kind: "pane" };
}

/** Where a connection dropped at `at` ends: a target handle, or a node's first target. */
export function dropTarget(frame: Frame, at: XY, source: Anchor): Anchor | undefined {
  for (const list of frame.anchors.values())
    for (const anchor of list)
      if (
        anchor.type === "target" &&
        anchor.nodeId !== source.nodeId &&
        anchor.cell.x === at.x &&
        anchor.cell.y === at.y
      )
        return anchor;
  for (let i = frame.placed.length - 1; i >= 0; i--) {
    const p = frame.placed[i];
    if (!p || p.node.id === source.nodeId || !contains(p.rect, at)) continue;
    if (p.node.type === "group") continue;
    return pickAnchor(frame.anchors.get(p.node.id) ?? [], "target", null);
  }
  return undefined;
}
