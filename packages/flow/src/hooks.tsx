import {
  createContext,
  useCallback,
  useContext,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { FlowStore } from "./store.ts";
import type { Detail, Edge, EdgeChange, Node, NodeChange, Viewport, XY } from "./types.ts";
import { applyEdgeChanges, applyNodeChanges } from "./vendor/xyflow/changes.ts";

export const StoreContext = createContext<FlowStore | null>(null);
/** The node a `<Handle>` belongs to. */
export const NodeIdContext = createContext<string | null>(null);

/**
 * Shares one canvas's store with components outside `<Flow>` (a side panel that calls
 * `fitView`, a toolbar): wrap both in it. Without it, `<Flow>` keeps its own.
 */
export function FlowProvider({
  children,
  defaultViewport,
  fitView,
}: {
  children: ReactNode;
  defaultViewport?: Viewport;
  fitView?: boolean;
}) {
  const [store] = useState(() => new FlowStore({ viewport: defaultViewport, fitView }));
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore(): FlowStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useFlow and the canvas components need a <Flow> or <FlowProvider>");
  return store;
}

/** Re-renders on every change of the store; returns it. */
export function useStoreVersion(): FlowStore {
  const store = useStore();
  useSyncExternalStore(store.subscribe, store.getVersion);
  return store;
}

/** `useState` for nodes, with the `onNodesChange` that applies the canvas's changes. */
export function useNodesState<N extends Node = Node>(
  initial: N[],
): [N[], Dispatch<SetStateAction<N[]>>, (changes: NodeChange<N>[]) => void] {
  const [nodes, setNodes] = useState(initial);
  const onNodesChange = useCallback(
    (changes: NodeChange<N>[]) => setNodes((current) => applyNodeChanges(changes, current)),
    [],
  );
  return [nodes, setNodes, onNodesChange];
}

/** `useState` for edges, with the `onEdgesChange` that applies the canvas's changes. */
export function useEdgesState<E extends Edge = Edge>(
  initial: E[],
): [E[], Dispatch<SetStateAction<E[]>>, (changes: EdgeChange<E>[]) => void] {
  const [edges, setEdges] = useState(initial);
  const onEdgesChange = useCallback(
    (changes: EdgeChange<E>[]) => setEdges((current) => applyEdgeChanges(changes, current)),
    [],
  );
  return [edges, setEdges, onEdgesChange];
}

export type FlowInstance = {
  getNodes(): readonly Node[];
  getNode(id: string): Node | undefined;
  getEdges(): readonly Edge[];
  getViewport(): Viewport;
  setViewport(viewport: Viewport): void;
  /** The closest zoom level at which every node is seen, centered. */
  fitView(): void;
  zoomIn(): void;
  zoomOut(): void;
  /** Centers the view on a point in flow coordinates. */
  setCenter(point: XY, zoom?: number): void;
  /** Pans just enough to show node `id`. */
  reveal(id: string): void;
  /** Proposes removing these nodes (with their edges) and edges. */
  deleteElements(elements: { nodes?: readonly string[]; edges?: readonly string[] }): void;
  /** Proposes selecting exactly these nodes and edges. */
  select(elements: { nodes?: readonly string[]; edges?: readonly string[] }): void;
  /** The canvas point at the center of the view, in flow coordinates. */
  center(): XY;
};

/** The canvas's controls, for a component inside `<Flow>` or `<FlowProvider>`. */
export function useFlow(): FlowInstance {
  const store = useStore();
  const [instance] = useState<FlowInstance>(() => ({
    getNodes: () => store.nodes,
    getNode: (id) => store.nodes.find((n) => n.id === id),
    getEdges: () => store.edges,
    getViewport: () => store.viewport,
    setViewport: (viewport) => store.setViewport(viewport),
    fitView: () => store.fitView(),
    zoomIn: () => store.zoom(1),
    zoomOut: () => store.zoom(-1),
    setCenter: (point, zoom) => store.setCenter(point, zoom),
    reveal: (id) => store.reveal(id),
    deleteElements: (elements) => store.deleteElements(elements),
    select: (elements) => store.select(elements),
    center: () =>
      store.toFlow({ x: Math.floor(store.size.width / 2), y: Math.floor(store.size.height / 2) }),
  }));
  return instance;
}

/** The viewport and the detail it draws nodes at, re-rendering when they change. */
export function useViewport(): Viewport & { detail: Detail } {
  const store = useStoreVersion();
  return { ...store.viewport, detail: store.detail };
}
