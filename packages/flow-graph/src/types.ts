import type { ReactNode } from "react";

/**
 * The graph's vocabulary, after React Flow's (`@xyflow/system` types): a node, an edge,
 * the changes an interaction proposes, the viewport. Coordinates are terminal cells: `x`
 * counts columns, `y` rows, and a row is about twice as tall as a column is wide.
 */

export type XY = { x: number; y: number };
export type Rect = { x: number; y: number; width: number; height: number };

/** Which side of a node a handle sits on. */
export type Position = "left" | "right" | "top" | "bottom";

/**
 * Semantic zoom: the terminal cannot scale glyphs, so zooming out spaces nodes closer and
 * draws less of each. `full` renders the node's component, `compact` its label on one
 * row, `dot` a single cell.
 */
export type Detail = "full" | "compact" | "dot";

/** A node as the application keeps it. `position` is relative to `parentId`'s, if any. */
export type Node<Data extends Record<string, unknown> = Record<string, unknown>> = {
  id: string;
  position: XY;
  data: Data;
  /** A key of `nodeTypes`, or a built-in: `default`, `input`, `output`, `group`. */
  type?: string;
  selected?: boolean;
  dragging?: boolean;
  hidden?: boolean;
  /** A group node this one sits in: its position is relative to the group's. */
  parentId?: string;
  /** Fixed size in cells (a group needs one); otherwise the rendered size is measured. */
  width?: number;
  height?: number;
  /** Where edges leave (default `right`) and arrive (default `left`) without a `<Handle>`. */
  sourcePosition?: Position;
  targetPosition?: Position;
  draggable?: boolean;
  selectable?: boolean;
  connectable?: boolean;
  zIndex?: number;
  /** The node's color where the canvas draws it itself: a dot when zoomed out, the minimap. */
  color?: string;
};

export type MarkerType = "arrow" | "none";

export type Edge<Data extends Record<string, unknown> = Record<string, unknown>> = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  /** A key of `edgeTypes`, or a built-in: `smoothstep` (default), `step`, `straight`, `bezier`. */
  type?: string;
  label?: string;
  /** Dashes that run from source to target. */
  animated?: boolean;
  selected?: boolean;
  hidden?: boolean;
  /** Default `arrow`. */
  markerEnd?: MarkerType;
  markerStart?: MarkerType;
  /** A color for the line, as `#rrggbb`. */
  color?: string;
  data?: Data;
};

export type Connection = {
  source: string;
  target: string;
  sourceHandle: string | null;
  targetHandle: string | null;
};

export type Viewport = { x: number; y: number; zoom: number };

// The changes, as @xyflow/system's types/changes.ts names them.
export type NodePositionChange = {
  id: string;
  type: "position";
  position?: XY;
  dragging?: boolean;
};
export type NodeDimensionsChange = {
  id: string;
  type: "dimensions";
  dimensions: { width: number; height: number };
};
export type SelectionChange = { id: string; type: "select"; selected: boolean };
export type RemoveChange = { id: string; type: "remove" };
export type AddChange<T> = { type: "add"; item: T; index?: number };
export type ReplaceChange<T> = { id: string; type: "replace"; item: T };

export type NodeChange<N extends Node = Node> =
  | NodePositionChange
  | NodeDimensionsChange
  | SelectionChange
  | RemoveChange
  | AddChange<N>
  | ReplaceChange<N>;
export type EdgeChange<E extends Edge = Edge> =
  | SelectionChange
  | RemoveChange
  | AddChange<E>
  | ReplaceChange<E>;

export type HandleType = "source" | "target";
/** A handle a node declared with `<Handle>`. */
export type HandleSpec = { id: string | null; type: HandleType; position: Position };

/** A node type: a function component of `NodeProps`. */
export type NodeComponent<N extends Node = Node> = (props: NodeProps<N>) => ReactNode;

/** What a node component receives. */
export type NodeProps<N extends Node = Node> = {
  id: string;
  data: N["data"];
  type: string;
  selected: boolean;
  dragging: boolean;
  /** `full` or `compact`: at `dot`, the canvas draws the node itself. */
  detail: Detail;
  /** Keyboard connection under way and this node is the proposed target. */
  connectTarget: boolean;
  width?: number;
  height?: number;
};
