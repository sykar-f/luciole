import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { RGBA, type BoxRenderable, type MouseEvent, type OptimizedBuffer } from "@opentui/core";
import { useBindings } from "@opentui/keymap/react";
import { composeFrame, dropTarget, hitTest, type EdgeType, type Frame } from "./frame.ts";
import { absolutePositions, detailFor, pickAnchor, placeNodes, type Placed } from "./geometry.ts";
import { NodeIdContext, StoreContext, useStoreVersion } from "./hooks.tsx";
import { cycle, follow, nearest, readingOrder, sibling } from "./navigation.ts";
import { FlowKeymap } from "./keymap.tsx";
import { builtinNodeTypes } from "./nodes.tsx";
import { FlowStore, type CanvasNodeChange } from "./store.ts";
import { defaultTheme, roleColor, ThemeContext, useFlowTheme, type FlowTheme } from "./theme.ts";
import type {
  Connection,
  Edge,
  EdgeChange,
  Node,
  NodeChange,
  NodeComponent,
  Viewport,
  XY,
} from "./types.ts";

const PAN_X = 4;
const PAN_Y = 2;
const ANIMATION_MS = 150;
const ANIMATION_STEPS = 12;
const LAYER_Z = 0;
const NODE_Z = 10;
const COLOR_CACHE_LIMIT = 256;
const MIN_COMPACT_WIDTH = 4;

export type FlowProps<N extends Node = Node, E extends Edge = Edge> = {
  nodes: N[];
  edges: E[];
  /** What the canvas proposes for nodes (drag, selection, removal); without it they stay put. */
  onNodesChange?: (changes: NodeChange<N>[]) => void;
  onEdgesChange?: (changes: EdgeChange<E>[]) => void;
  /** A connection made by dragging from a handle, or with the keyboard (`c`, then Enter). */
  onConnect?: (connection: Connection) => void;
  onNodeClick?: (node: N) => void;
  onEdgeClick?: (edge: E) => void;
  onPaneClick?: (at: XY) => void;
  /** The end of a mouse drag, with the nodes it moved at their new positions. */
  onNodeDragStop?: (nodes: N[]) => void;
  onViewportChange?: (viewport: Viewport) => void;
  nodeTypes?: Record<string, NodeComponent<N>>;
  edgeTypes?: Record<string, EdgeType>;
  /** The type of edges that name none. Default `smoothstep`. */
  defaultEdgeType?: string;
  /** Fit every node in view once the canvas has a size. */
  fitView?: boolean;
  defaultViewport?: Viewport;
  /** Keyboard bindings (group `flow`); off while a field elsewhere takes the keys. */
  keyboard?: boolean;
  /** Curves in braille. Without, bezier and slanted edges are drawn as smoothstep. */
  braille?: boolean;
  theme?: Partial<FlowTheme>;
  id?: string;
  /** `<Background>`, `<MiniMap>`, `<Controls>`, `<Panel>`. */
  children?: ReactNode;
};

/**
 * A node graph on the terminal, after React Flow's `<ReactFlow>`: controlled `nodes` and
 * `edges`, changes proposed through `onNodesChange`/`onEdgesChange`. Pan, zoom and drag
 * stay on the Client; nothing reaches the Server unless the application sends it.
 */
export function Flow<N extends Node = Node, E extends Edge = Edge>(props: FlowProps<N, E>) {
  const outer = useContext(StoreContext);
  const [own] = useState(() => (outer ? null : new FlowStore({ viewport: props.defaultViewport })));
  const store = outer ?? own;
  const theme = useMemo(() => ({ ...defaultTheme, ...props.theme }), [props.theme]);
  if (!store) return null;
  return (
    <StoreContext.Provider value={store}>
      <ThemeContext.Provider value={theme}>
        <FlowKeymap>
          <Canvas {...props} />
        </FlowKeymap>
      </ThemeContext.Provider>
    </StoreContext.Provider>
  );
}

type Drag =
  | { kind: "nodes"; start: XY; origins: Map<string, XY>; delta: XY | null }
  | { kind: "pan"; start: XY; viewport: Viewport }
  | { kind: "connect" };

function Canvas<N extends Node, E extends Edge>(props: FlowProps<N, E>) {
  const store = useStoreVersion();
  const theme = useFlowTheme();
  const canvas = useRef<BoxRenderable>(null);
  const frameRef = useRef<Frame | null>(null);
  const drag = useRef<Drag | null>(null);
  const [focus, setFocus] = useState<string | undefined>(undefined);
  const { nodes, edges, keyboard = true } = props;

  useLayoutEffect(() =>
    store.sync({
      nodes,
      edges,
      callbacks: {
        onNodesChange: props.onNodesChange,
        onEdgesChange: props.onEdgesChange,
        onConnect: props.onConnect,
        onViewportChange: props.onViewportChange,
      },
    }),
  );
  const fit = props.fitView ?? false;
  useLayoutEffect(() => {
    if (fit) store.fitView();
  }, [store, fit]);

  const detail = store.detail;
  const placed = placeNodes(nodes, store.viewport, store.measured);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const edgeById = useMemo(() => new Map(edges.map((e) => [e.id, e])), [edges]);
  const selectedNodes = nodes.filter((n) => n.selected).map((n) => n.id);
  const selectedEdges = edges.filter((e) => e.selected).map((e) => e.id);
  const current = focus && selectedNodes.includes(focus) ? focus : selectedNodes[0];

  const local = (event: MouseEvent): XY => ({
    x: event.x - (canvas.current?.x ?? 0),
    y: event.y - (canvas.current?.y ?? 0),
  });
  const selectNode = (id: string, options: { reveal?: boolean } = {}) => {
    setFocus(id);
    store.select({ nodes: [id] });
    if (options.reveal) store.reveal(id);
  };

  // ── Mouse ───────────────────────────────────────────────────────────────
  const onMouseDown = (event: MouseEvent) => {
    const frame = frameRef.current;
    if (!frame || event.button !== 0) return;
    const at = local(event);
    const hit = hitTest(frame, at);
    if (hit.kind === "handle" && props.onConnect) {
      store.setConnecting({ source: hit.anchor, pointer: at });
      drag.current = { kind: "connect" };
      return;
    }
    if (hit.kind === "node" || hit.kind === "handle") {
      const node = hit.kind === "node" ? hit.node : byId.get(hit.anchor.nodeId);
      if (!node) return;
      const original = byId.get(node.id);
      if (node.selectable !== false) {
        if (event.modifiers.shift)
          store.select({
            nodes: node.selected
              ? selectedNodes.filter((id) => id !== node.id)
              : [...selectedNodes, node.id],
            edges: selectedEdges,
          });
        else if (!node.selected) selectNode(node.id);
        setFocus(node.id);
      }
      if (original) props.onNodeClick?.(original);
      const moving = (node.selected ? nodes.filter((n) => n.selected) : [node]).filter(
        (n) => n.draggable !== false,
      );
      drag.current = {
        kind: "nodes",
        start: at,
        origins: new Map(moving.map((n) => [n.id, n.position])),
        delta: null,
      };
      return;
    }
    if (hit.kind === "edge") {
      store.select({
        edges: event.modifiers.shift ? [...selectedEdges, hit.id] : [hit.id],
      });
      const edge = edgeById.get(hit.id);
      if (edge) props.onEdgeClick?.(edge);
      return;
    }
    store.select({});
    props.onPaneClick?.(store.toFlow(at));
    drag.current = { kind: "pan", start: at, viewport: store.viewport };
  };

  const onMouseDrag = (event: MouseEvent) => {
    const d = drag.current;
    if (!d) return;
    const at = local(event);
    if (d.kind === "connect") {
      if (store.connecting) store.setConnecting({ ...store.connecting, pointer: at });
      return;
    }
    if (d.kind === "pan") {
      store.setViewport({
        ...d.viewport,
        x: d.viewport.x + at.x - d.start.x,
        y: d.viewport.y + at.y - d.start.y,
      });
      return;
    }
    const { zoom } = store.viewport;
    const dx = Math.round((at.x - d.start.x) / zoom);
    const dy = Math.round((at.y - d.start.y) / zoom);
    if (dx === 0 && dy === 0 && !d.delta) return;
    d.delta = { x: dx, y: dy };
    store.proposeNodes(
      [...d.origins].map(([id, o]) => ({
        id,
        type: "position",
        position: { x: o.x + dx, y: o.y + dy },
        dragging: true,
      })),
    );
  };

  const onMouseDragEnd = (event: MouseEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === "connect") {
      const connecting = store.connecting;
      const frame = frameRef.current;
      store.setConnecting(null);
      if (!connecting || !frame) return;
      const target = dropTarget(frame, local(event), connecting.source);
      if (target)
        store.connect({
          source: connecting.source.nodeId,
          sourceHandle: connecting.source.handle,
          target: target.nodeId,
          targetHandle: target.handle,
        });
      return;
    }
    const delta = d.kind === "nodes" ? d.delta : null;
    if (d.kind !== "nodes" || !delta) return;
    // The last proposal, not the nodes: the application may not have rendered it yet.
    const moved = [...d.origins].map(([id, o]) => ({
      id,
      position: { x: o.x + delta.x, y: o.y + delta.y },
    }));
    store.proposeNodes(moved.map((m) => ({ ...m, type: "position", dragging: false })));
    props.onNodeDragStop?.(
      moved.flatMap((m) => {
        const original = byId.get(m.id);
        return original ? [{ ...original, position: m.position, dragging: false }] : [];
      }),
    );
  };

  // A click without drag still ends a connection started on a handle.
  const onMouseUp = () => {
    if (drag.current?.kind === "connect") {
      drag.current = null;
      store.setConnecting(null);
    } else if (drag.current?.kind !== "nodes") drag.current = null;
  };

  const onMouseScroll = (event: MouseEvent) => {
    const direction = event.scroll?.direction;
    if (!direction) return;
    if (event.modifiers.ctrl || event.modifiers.alt) {
      if (direction === "up" || direction === "down")
        store.zoom(direction === "up" ? 1 : -1, local(event));
      return;
    }
    const horizontal = event.modifiers.shift
      ? direction === "up"
        ? "left"
        : direction === "down"
          ? "right"
          : direction
      : direction;
    if (horizontal === "up") store.panBy(0, PAN_Y);
    else if (horizontal === "down") store.panBy(0, -PAN_Y);
    else if (horizontal === "left") store.panBy(PAN_X, 0);
    else store.panBy(-PAN_X, 0);
  };

  // ── Keyboard ────────────────────────────────────────────────────────────
  const order = readingOrder(nodes, absolutePositions(nodes));
  const connecting = store.connecting;
  const moveSelected = (dx: number, dy: number) => {
    const step = Math.max(1, Math.round(1 / store.viewport.zoom));
    const changes: CanvasNodeChange[] = nodes
      .filter((n) => n.selected && n.draggable !== false)
      .map((n) => ({
        id: n.id,
        type: "position",
        position: { x: n.position.x + dx * step, y: n.position.y + dy * step },
      }));
    store.proposeNodes(changes);
    if (current) store.reveal(current);
  };
  const go = (id: string | undefined) => {
    if (!id) return;
    if (connecting) {
      store.setConnecting({ ...connecting, target: id });
      store.reveal(id);
    } else selectNode(id, { reveal: true });
  };
  const startConnect = () => {
    if (!current || !props.onConnect) return;
    const p = placed.find((x) => x.node.id === current);
    const source = p && pickAnchor(store.anchors(p), "source", null);
    if (!source) return;
    const others = order.filter((n) => n.id !== current);
    const target = nearest(order, current, "right") ?? others[0]?.id;
    store.setConnecting({ source, target });
    if (target) store.reveal(target);
  };
  const confirmConnect = () => {
    if (!connecting?.target) return;
    const target = connecting.target;
    const p = placed.find((x) => x.node.id === target);
    const anchor = p && pickAnchor(store.anchors(p), "target", null);
    store.setConnecting(null);
    if (!anchor) return;
    store.connect({
      source: connecting.source.nodeId,
      sourceHandle: connecting.source.handle,
      target: anchor.nodeId,
      targetHandle: anchor.handle,
    });
  };
  const at = connecting?.target ?? current;
  const nextEdge = () => {
    const list = edges.filter(
      (e) => !e.hidden && (!current || e.source === current || e.target === current),
    );
    if (list.length === 0) return;
    const index = list.findIndex((e) => e.selected);
    const edge = list[(index + 1) % list.length];
    if (edge) store.select({ nodes: current ? [current] : [], edges: [edge.id] });
  };

  useBindings(
    () => ({
      bindings: keyboard
        ? [
            { key: "h", cmd: () => store.panBy(PAN_X, 0) },
            { key: "left", cmd: () => store.panBy(PAN_X, 0) },
            { key: "l", cmd: () => store.panBy(-PAN_X, 0) },
            { key: "right", cmd: () => store.panBy(-PAN_X, 0) },
            { key: "k", cmd: () => store.panBy(0, PAN_Y) },
            { key: "up", cmd: () => store.panBy(0, PAN_Y) },
            { key: "j", cmd: () => store.panBy(0, -PAN_Y) },
            { key: "down", cmd: () => store.panBy(0, -PAN_Y) },
            ...(current && !connecting
              ? [
                  {
                    key: "shift+h",
                    cmd: () => moveSelected(-1, 0),
                  },
                  { key: "shift+left", cmd: () => moveSelected(-1, 0) },
                  { key: "shift+l", cmd: () => moveSelected(1, 0) },
                  { key: "shift+right", cmd: () => moveSelected(1, 0) },
                  { key: "shift+k", cmd: () => moveSelected(0, -1) },
                  { key: "shift+up", cmd: () => moveSelected(0, -1) },
                  { key: "shift+j", cmd: () => moveSelected(0, 1) },
                  { key: "shift+down", cmd: () => moveSelected(0, 1) },
                ]
              : []),
            {
              key: "tab",
              cmd: () =>
                go(
                  cycle(
                    order.filter((n) => n.id !== connecting?.source.nodeId),
                    at,
                    1,
                  ),
                ),
              desc: "next",
              group: "flow",
            },
            {
              key: "shift+tab",
              cmd: () =>
                go(
                  cycle(
                    order.filter((n) => n.id !== connecting?.source.nodeId),
                    at,
                    -1,
                  ),
                ),
            },
            ...(at
              ? [
                  {
                    key: "]",
                    cmd: () => go(follow(edges, order, at, "down")),
                    desc: "downstream",
                    group: "flow",
                  },
                  {
                    key: "[",
                    cmd: () => go(follow(edges, order, at, "up")),
                    desc: "upstream",
                    group: "flow",
                  },
                  { key: "}", cmd: () => go(sibling(edges, order, at, 1)) },
                  { key: "{", cmd: () => go(sibling(edges, order, at, -1)) },
                ]
              : []),
            ...(connecting
              ? [
                  { key: "return", cmd: confirmConnect, desc: "connect", group: "flow" },
                  {
                    key: "escape",
                    cmd: () => store.setConnecting(null),
                    desc: "cancel",
                    group: "flow",
                  },
                ]
              : [
                  ...(current && props.onConnect
                    ? [{ key: "c", cmd: startConnect, desc: "connect", group: "flow" }]
                    : []),
                  ...(selectedNodes.length > 0 || selectedEdges.length > 0
                    ? [
                        {
                          key: "x",
                          cmd: () =>
                            store.deleteElements({ nodes: selectedNodes, edges: selectedEdges }),
                          desc: "delete",
                          group: "flow",
                        },
                        {
                          key: "delete",
                          cmd: () =>
                            store.deleteElements({ nodes: selectedNodes, edges: selectedEdges }),
                        },
                        { key: "escape", cmd: () => store.select({}) },
                      ]
                    : []),
                  ...(edges.length > 0
                    ? [{ key: "e", cmd: nextEdge, desc: "edges", group: "flow" }]
                    : []),
                ]),
            { key: "=", cmd: () => store.zoom(1), desc: "zoom in", group: "flow" },
            { key: "+", cmd: () => store.zoom(1) },
            { key: "-", cmd: () => store.zoom(-1), desc: "zoom out", group: "flow" },
            { key: "0", cmd: () => store.fitView(), desc: "fit", group: "flow" },
          ]
        : [],
    }),
    [
      keyboard,
      store,
      current,
      at,
      connecting,
      order,
      edges,
      nodes,
      selectedNodes.join(),
      selectedEdges.join(),
    ],
  );

  // ── Render ──────────────────────────────────────────────────────────────
  // Compact nodes are as wide as they were at full detail, scaled: spaced as they were.
  const compactWidth = (node: Node) => {
    const full = store.full.get(node.id);
    if (detail !== "compact" || node.type === "group" || !full) return undefined;
    return Math.max(MIN_COMPACT_WIDTH, Math.round(full.width * store.viewport.zoom));
  };
  const typeOf = (type: string | undefined): NodeComponent<N> | undefined =>
    props.nodeTypes?.[type ?? "default"] ??
    builtinNodeTypes[type ?? "default"] ??
    builtinNodeTypes.default;
  return (
    <box
      ref={canvas}
      id={props.id}
      flexGrow={1}
      position="relative"
      overflow="hidden"
      onSizeChange={() => {
        const box = canvas.current;
        if (box) store.setSize({ width: box.width, height: box.height });
      }}
      onMouseDown={onMouseDown}
      onMouseDrag={onMouseDrag}
      onMouseDragEnd={onMouseDragEnd}
      onMouseUp={onMouseUp}
      onMouseScroll={onMouseScroll}
    >
      <EdgeLayer
        store={store}
        nodes={nodes}
        edges={edges}
        theme={theme}
        edgeTypes={props.edgeTypes}
        defaultEdgeType={props.defaultEdgeType}
        braille={props.braille}
        frameRef={frameRef}
      />
      {placed.map((p, index) => {
        const node = byId.get(p.node.id);
        const Component = typeOf(p.node.type);
        if (!node || !Component) return null;
        return (
          <NodeView
            key={p.node.id}
            store={store}
            placed={p}
            zIndex={NODE_Z + index}
            dot={detail === "dot" && node.type !== "group"}
            maxWidth={compactWidth(node)}
            color={node.color ?? (node.selected ? theme.selected : theme.text)}
          >
            <Component
              id={node.id}
              data={node.data}
              type={node.type ?? "default"}
              selected={Boolean(node.selected)}
              dragging={Boolean(node.dragging)}
              detail={detail}
              connectTarget={connecting?.target === node.id}
              width={node.width === undefined ? undefined : p.rect.width}
              height={node.height === undefined ? undefined : p.rect.height}
            />
          </NodeView>
        );
      })}
      {props.children}
    </box>
  );
}

/** A node at its place, measured after each layout. */
function NodeView({
  store,
  placed,
  zIndex,
  dot,
  color,
  maxWidth,
  children,
}: {
  store: FlowStore;
  placed: Placed;
  zIndex: number;
  dot: boolean;
  color: string;
  /** Clips what the node draws: a compact label never spills over its neighbours. */
  maxWidth?: number;
  children: ReactNode;
}) {
  const ref = useRef<BoxRenderable>(null);
  const { node, rect } = placed;
  const detail = detailFor(store.viewport.zoom);
  const measure = () => {
    const box = ref.current;
    if (box && box.width > 0 && box.height > 0)
      store.measure(node.id, { width: box.width, height: box.height, detail });
  };
  return (
    <box
      ref={ref}
      position="absolute"
      left={rect.x}
      top={rect.y}
      zIndex={zIndex}
      flexDirection="column"
      width={maxWidth ?? "auto"}
      overflow={maxWidth === undefined ? "visible" : "hidden"}
      onSizeChange={measure}
    >
      <NodeIdContext.Provider value={node.id}>
        {dot ? (
          <text selectable={false} fg={color}>
            {node.selected ? "◉" : "●"}
          </text>
        ) : (
          children
        )}
      </NodeIdContext.Provider>
    </box>
  );
}

const colors = new Map<string, RGBA>();
function rgba(hex: string): RGBA {
  const known = colors.get(hex);
  if (known) return known;
  if (colors.size > COLOR_CACHE_LIMIT) colors.clear();
  const color = RGBA.fromHex(hex);
  colors.set(hex, color);
  return color;
}
const TRANSPARENT = RGBA.fromValues(0, 0, 0, 0);

/** Edges, labels, handles and the background: one grid, copied under the nodes. */
function EdgeLayer({
  store,
  nodes,
  edges,
  theme,
  edgeTypes,
  defaultEdgeType,
  braille,
  frameRef,
}: {
  store: FlowStore;
  nodes: readonly Node[];
  edges: readonly Edge[];
  theme: FlowTheme;
  edgeTypes?: Record<string, EdgeType>;
  defaultEdgeType?: string;
  braille?: boolean;
  frameRef: { current: Frame | null };
}) {
  const layer = useRef<BoxRenderable>(null);
  const [phase, setPhase] = useState(0);
  const animated = edges.some((e) => e.animated && !e.hidden);
  useEffect(() => {
    if (!animated) return;
    const timer = setInterval(() => setPhase((p) => (p + 1) % ANIMATION_STEPS), ANIMATION_MS);
    return () => clearInterval(timer);
  }, [animated]);

  const frame = composeFrame({
    size: store.size,
    viewport: store.viewport,
    nodes,
    edges,
    measured: store.measured,
    handles: store.handles,
    background: store.background,
    connecting: store.connecting,
    edgeTypes,
    defaultEdgeType,
    braille,
    phase,
  });
  const labelBg = rgba(theme.labelBg);
  const background = store.background;

  // Hit tests read the frame the user sees.
  useLayoutEffect(() => {
    frameRef.current = frame;
    layer.current?.requestRender();
  });
  return (
    <box
      ref={layer}
      position="absolute"
      left={0}
      top={0}
      width="100%"
      height="100%"
      zIndex={LAYER_Z}
      renderBefore={function (this: { x: number; y: number }, buffer: OptimizedBuffer) {
        for (const [x, y, cell] of frame.grid.entries()) {
          // A selected edge shows as selected, whatever its own color.
          const color =
            cell.role === "background" && background?.color
              ? background.color
              : cell.role === "selected"
                ? theme.selected
                : (cell.color ?? roleColor(theme, cell.role));
          buffer.setCellWithAlphaBlending(
            this.x + x,
            this.y + y,
            cell.char,
            rgba(color),
            cell.role === "label" ? labelBg : TRANSPARENT,
          );
        }
      }}
    />
  );
}
