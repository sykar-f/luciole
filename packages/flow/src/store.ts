/**
 * What one canvas knows beyond its props: the viewport, the canvas size, each node's
 * measured size and declared handles, the background, a connection under way, and what
 * the last frame placed where (for hit tests). Framework-free: `<Flow>` and the hooks
 * read it with `useSyncExternalStore`.
 */
import {
  anchorsOf,
  detailFor,
  fitViewport,
  flowBounds,
  panToShow,
  placeNodes,
  stepZoom,
  toFlow,
  zoomAround,
  type Anchor,
  type Measured,
  type Placed,
  type Size,
} from "./geometry.ts";
import type { BackgroundVariant } from "./raster.ts";
import type {
  Connection,
  Detail,
  Edge,
  EdgeChange,
  HandleSpec,
  Node,
  NodeChange,
  Viewport,
  XY,
} from "./types.ts";

export type BackgroundConfig = { variant: BackgroundVariant; gap: XY; color?: string };

/** A connection being made: by dragging from a handle, or with the keyboard. */
export type Connecting = {
  source: Anchor;
  /** The pointer, in canvas cells, while dragging. */
  pointer?: XY;
  /** The proposed target node, with the keyboard. */
  target?: string;
};

/** The changes the canvas itself proposes: never an addition or a replacement. */
export type CanvasNodeChange = Exclude<NodeChange, { type: "add" } | { type: "replace" }>;
export type CanvasEdgeChange = Exclude<EdgeChange, { type: "add" } | { type: "replace" }>;

export type Callbacks = {
  onNodesChange?: (changes: CanvasNodeChange[]) => void;
  onEdgesChange?: (changes: CanvasEdgeChange[]) => void;
  onConnect?: (connection: Connection) => void;
  onViewportChange?: (viewport: Viewport) => void;
};

const DEFAULT_VIEWPORT: Viewport = { x: 2, y: 1, zoom: 1 };

export class FlowStore {
  viewport: Viewport;
  size: Size = { width: 0, height: 0 };
  nodes: readonly Node[] = [];
  edges: readonly Edge[] = [];
  readonly measured = new Map<string, Measured>();
  /** The last size each node had at full detail: the view fits it at any zoom. */
  readonly full = new Map<string, Measured>();
  readonly handles = new Map<string, Map<string, HandleSpec>>();
  background: BackgroundConfig | null = null;
  connecting: Connecting | null = null;
  callbacks: Callbacks = {};
  /** Fit the view once the canvas has a size. */
  private pendingFit: boolean;
  private version = 0;
  private readonly listeners = new Set<() => void>();

  constructor(options: { viewport?: Viewport; fitView?: boolean } = {}) {
    this.viewport = options.viewport ?? DEFAULT_VIEWPORT;
    this.pendingFit = options.fitView ?? false;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getVersion = () => this.version;
  private changed() {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  get detail(): Detail {
    return detailFor(this.viewport.zoom);
  }

  /** The latest props: served to hooks and event handlers, which run after the commit. */
  sync(props: { nodes: readonly Node[]; edges: readonly Edge[]; callbacks: Callbacks }) {
    this.callbacks = props.callbacks;
    if (props.nodes === this.nodes && props.edges === this.edges) return;
    this.nodes = props.nodes;
    this.edges = props.edges;
    this.changed();
  }

  setViewport(viewport: Viewport) {
    const { x, y, zoom } = this.viewport;
    if (viewport.x === x && viewport.y === y && viewport.zoom === zoom) return;
    this.viewport = { x: Math.round(viewport.x), y: Math.round(viewport.y), zoom: viewport.zoom };
    this.callbacks.onViewportChange?.(this.viewport);
    this.changed();
  }
  panBy(dx: number, dy: number) {
    this.setViewport({ ...this.viewport, x: this.viewport.x + dx, y: this.viewport.y + dy });
  }
  /** One zoom level in or out, around `anchor` (the canvas center by default). */
  zoom(direction: 1 | -1, anchor?: XY) {
    const zoom = stepZoom(this.viewport.zoom, direction);
    if (zoom === this.viewport.zoom) return;
    const center = anchor ?? {
      x: Math.floor(this.size.width / 2),
      y: Math.floor(this.size.height / 2),
    };
    this.setViewport(zoomAround(this.viewport, zoom, center));
  }
  fitView() {
    if (this.size.width === 0 || this.size.height === 0) {
      this.pendingFit = true;
      return;
    }
    this.pendingFit = false;
    this.setViewport(fitViewport(flowBounds(this.nodes, this.full), this.size));
  }
  /** Centers the view on a flow point, at `zoom` or the current one. */
  setCenter(point: XY, zoom = this.viewport.zoom) {
    this.setViewport({
      x: Math.round(this.size.width / 2 - point.x * zoom),
      y: Math.round(this.size.height / 2 - point.y * zoom),
      zoom,
    });
  }
  /** Pans just enough for node `id` to be seen whole. */
  reveal(id: string) {
    const placed = this.place().find((p) => p.node.id === id);
    if (placed) this.setViewport(panToShow(this.viewport, placed.rect, this.size));
  }
  setSize(size: Size) {
    if (size.width === this.size.width && size.height === this.size.height) return;
    this.size = size;
    if (this.pendingFit) this.fitView();
    this.changed();
  }
  measure(id: string, size: Measured) {
    const known = this.measured.get(id);
    if (
      known &&
      known.width === size.width &&
      known.height === size.height &&
      known.detail === size.detail
    )
      return;
    this.measured.set(id, size);
    if (size.detail === "full") this.full.set(id, size);
    this.changed();
  }

  addHandle(nodeId: string, key: string, spec: HandleSpec) {
    const handles = this.handles.get(nodeId) ?? new Map<string, HandleSpec>();
    handles.set(key, spec);
    this.handles.set(nodeId, handles);
    this.changed();
  }
  removeHandle(nodeId: string, key: string) {
    const handles = this.handles.get(nodeId);
    if (!handles?.delete(key)) return;
    if (handles.size === 0) this.handles.delete(nodeId);
    this.changed();
  }
  setBackground(background: BackgroundConfig | null) {
    this.background = background;
    this.changed();
  }
  setConnecting(connecting: Connecting | null) {
    this.connecting = connecting;
    this.changed();
  }

  /** The nodes on the canvas, in drawing order. */
  place(): Placed[] {
    return placeNodes(this.nodes, this.viewport, this.measured);
  }
  anchors(placed: Placed): Anchor[] {
    return anchorsOf(placed, [...(this.handles.get(placed.node.id)?.values() ?? [])], this.detail);
  }
  /** A canvas cell as a flow point. */
  toFlow(cell: XY): XY {
    return toFlow(cell, this.viewport);
  }

  // What an interaction proposes: the application applies it (or not) to its own state.
  proposeNodes(changes: CanvasNodeChange[]) {
    if (changes.length > 0) this.callbacks.onNodesChange?.(changes);
  }
  proposeEdges(changes: CanvasEdgeChange[]) {
    if (changes.length > 0) this.callbacks.onEdgesChange?.(changes);
  }
  /** Selects exactly `nodes` and `edges` (ids), deselecting the rest. */
  select({ nodes = [], edges = [] }: { nodes?: readonly string[]; edges?: readonly string[] }) {
    const n = new Set(nodes);
    const e = new Set(edges);
    this.proposeNodes(
      this.nodes
        .filter((node) => Boolean(node.selected) !== n.has(node.id))
        .map((node) => ({ id: node.id, type: "select", selected: n.has(node.id) })),
    );
    this.proposeEdges(
      this.edges
        .filter((edge) => Boolean(edge.selected) !== e.has(edge.id))
        .map((edge) => ({ id: edge.id, type: "select", selected: e.has(edge.id) })),
    );
  }
  /** Removes nodes (with their edges) and edges. */
  deleteElements({
    nodes = [],
    edges = [],
  }: {
    nodes?: readonly string[];
    edges?: readonly string[];
  }) {
    const gone = new Set(nodes);
    // A group's children go with it.
    for (const node of this.nodes) if (node.parentId && gone.has(node.parentId)) gone.add(node.id);
    const edgeIds = new Set(edges);
    for (const edge of this.edges)
      if (gone.has(edge.source) || gone.has(edge.target)) edgeIds.add(edge.id);
    this.proposeEdges([...edgeIds].map((id) => ({ id, type: "remove" })));
    this.proposeNodes([...gone].map((id) => ({ id, type: "remove" })));
  }
  connect(connection: Connection) {
    this.callbacks.onConnect?.(connection);
  }
}
