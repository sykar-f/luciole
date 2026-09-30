/**
 * @luciole/flow's model: semantic zoom, placement, handles, fitting the view, the
 * changes the canvas proposes, and keyboard navigation over the graph.
 */
import { expect, test } from "bun:test";
import {
  absolutePositions,
  anchorsOf,
  detailFor,
  fitViewport,
  flowBounds,
  panToShow,
  placeNodes,
  stepZoom,
  zoomAround,
} from "../src/geometry.ts";
import { cycle, follow, nearest, readingOrder, sibling } from "../src/navigation.ts";
import { FlowStore, type CanvasEdgeChange, type CanvasNodeChange } from "../src/store.ts";
import type { Edge, Node } from "../src/types.ts";
import { addEdge, applyEdgeChanges, applyNodeChanges } from "../src/vendor/xyflow/changes.ts";

const node = (id: string, x: number, y: number, extra: Partial<Node> = {}): Node => ({
  id,
  position: { x, y },
  data: { label: id },
  ...extra,
});

test("zoom has three levels, each with less detail", () => {
  expect([1, 0.5, 0.25].map(detailFor)).toEqual(["full", "compact", "dot"]);
  expect(stepZoom(1, -1)).toBe(0.5);
  expect(stepZoom(0.25, -1)).toBe(0.25);
  expect(stepZoom(0.5, 1)).toBe(1);
  // The flow point under the anchor cell stays there.
  expect(zoomAround({ x: 0, y: 0, zoom: 1 }, 0.5, { x: 10, y: 4 })).toEqual({
    x: 5,
    y: 2,
    zoom: 0.5,
  });
});

test("a child is placed relative to its group, and drawn over it", () => {
  const nodes = [
    node("g", 10, 5, { type: "group", width: 30, height: 10 }),
    node("child", 2, 3, { parentId: "g" }),
  ];
  expect(absolutePositions(nodes).get("child")).toEqual({ x: 12, y: 8 });
  const placed = placeNodes(nodes, { x: 1, y: 1, zoom: 1 }, new Map());
  expect(placed.map((p) => [p.node.id, p.rect])).toEqual([
    ["g", { x: 11, y: 6, width: 30, height: 10 }],
    ["child", { x: 13, y: 9, width: 9, height: 3 }],
  ]);
  // Zoomed out, the child shrinks to its label and the group scales.
  const compact = placeNodes(nodes, { x: 0, y: 0, zoom: 0.5 }, new Map());
  expect(compact.map((p) => p.rect)).toEqual([
    { x: 5, y: 3, width: 15, height: 5 },
    { x: 6, y: 4, width: 7, height: 1 },
  ]);
});

test("a measured size replaces the estimate, at the detail it was measured at", () => {
  const nodes = [node("a", 0, 0)];
  const measured = new Map([["a", { width: 20, height: 5, detail: "full" as const }]]);
  expect(placeNodes(nodes, { x: 0, y: 0, zoom: 1 }, measured)[0]?.rect.width).toBe(20);
  expect(placeNodes(nodes, { x: 0, y: 0, zoom: 0.5 }, measured)[0]?.rect.width).toBe(6);
});

test("handles on one side are spread along it", () => {
  const [placed] = placeNodes(
    [node("a", 0, 0, { width: 10, height: 7 })],
    { x: 0, y: 0, zoom: 1 },
    new Map(),
  );
  if (!placed) throw new Error("not placed");
  const anchors = anchorsOf(
    placed,
    [
      { id: "yes", type: "source", position: "right" },
      { id: "no", type: "source", position: "right" },
      { id: null, type: "target", position: "top" },
    ],
    "full",
  );
  expect(anchors.map((a) => [a.handle, a.cell])).toEqual([
    ["yes", { x: 10, y: 1 }],
    ["no", { x: 10, y: 4 }],
    [null, { x: 4, y: -1 }],
  ]);
});

test("fitting picks the closest zoom level at which every node is seen, centered", () => {
  const nodes = [node("a", 0, 0), node("b", 60, 10)];
  const bounds = flowBounds(nodes, new Map());
  expect(bounds).toEqual({ x: 0, y: 0, width: 68, height: 13 });
  expect(fitViewport(bounds, { width: 80, height: 20 })).toEqual({ x: 6, y: 4, zoom: 1 });
  expect(fitViewport(bounds, { width: 40, height: 20 })).toEqual({ x: 3, y: 7, zoom: 0.5 });
});

test("revealing a node pans only as much as needed", () => {
  const viewport = { x: 0, y: 0, zoom: 1 };
  const canvas = { width: 40, height: 10 };
  expect(panToShow(viewport, { x: 5, y: 2, width: 9, height: 3 }, canvas)).toBe(viewport);
  expect(panToShow(viewport, { x: 38, y: 2, width: 9, height: 3 }, canvas)).toEqual({
    x: -8,
    y: 0,
    zoom: 1,
  });
  expect(panToShow(viewport, { x: 5, y: -4, width: 9, height: 3 }, canvas)).toEqual({
    x: 0,
    y: 5,
    zoom: 1,
  });
});

test("changes apply to the application's nodes and edges as in React Flow", () => {
  const nodes = [node("a", 0, 0), node("b", 5, 5)];
  const moved = applyNodeChanges(
    [
      { id: "a", type: "position", position: { x: 3, y: 1 }, dragging: true },
      { id: "b", type: "select", selected: true },
      { type: "add", item: node("c", 9, 9) },
    ],
    nodes,
  );
  expect(moved.map((n) => [n.id, n.position, n.selected, n.dragging])).toEqual([
    ["a", { x: 3, y: 1 }, undefined, true],
    ["b", { x: 5, y: 5 }, true, undefined],
    ["c", { x: 9, y: 9 }, undefined, undefined],
  ]);
  expect(nodes[0]?.position).toEqual({ x: 0, y: 0 });
  const edges = addEdge({ source: "a", target: "b", sourceHandle: null, targetHandle: null }, []);
  expect(edges).toEqual([{ id: "xy-edge__a-b", source: "a", target: "b" }]);
  // The same connection twice is one edge.
  expect(
    addEdge({ source: "a", target: "b", sourceHandle: null, targetHandle: null }, edges),
  ).toHaveLength(1);
  expect(applyEdgeChanges([{ id: "xy-edge__a-b", type: "remove" }], edges)).toEqual([]);
});

test("the store proposes selections and removals; a removed node takes its edges", () => {
  const store = new FlowStore();
  const nodeChanges: CanvasNodeChange[][] = [];
  const edgeChanges: CanvasEdgeChange[][] = [];
  store.sync({
    nodes: [node("a", 0, 0, { selected: true }), node("b", 10, 0), node("c", 20, 0)],
    edges: [
      { id: "ab", source: "a", target: "b" },
      { id: "bc", source: "b", target: "c", selected: true },
    ],
    callbacks: {
      onNodesChange: (c) => nodeChanges.push(c),
      onEdgesChange: (c) => edgeChanges.push(c),
    },
  });
  store.select({ nodes: ["b"] });
  expect(nodeChanges.pop()).toEqual([
    { id: "a", type: "select", selected: false },
    { id: "b", type: "select", selected: true },
  ]);
  expect(edgeChanges.pop()).toEqual([{ id: "bc", type: "select", selected: false }]);
  store.deleteElements({ nodes: ["b"] });
  expect(edgeChanges.pop()).toEqual([
    { id: "ab", type: "remove" },
    { id: "bc", type: "remove" },
  ]);
  expect(nodeChanges.pop()).toEqual([{ id: "b", type: "remove" }]);
});

test("the store fits the view once the canvas has a size", () => {
  const store = new FlowStore();
  store.sync({ nodes: [node("a", 100, 50)], edges: [], callbacks: {} });
  store.fitView();
  expect(store.viewport).toEqual({ x: 2, y: 1, zoom: 1 });
  store.setSize({ width: 40, height: 11 });
  expect(store.viewport).toEqual({ x: -84, y: -46, zoom: 1 });
});

// A pipeline: checkout → lint, test → build; test → e2e.
const graph = [
  node("checkout", 0, 4),
  node("lint", 20, 0),
  node("test", 20, 8),
  node("build", 40, 4),
  node("e2e", 40, 12),
];
const edges: Edge[] = [
  { id: "1", source: "checkout", target: "lint" },
  { id: "2", source: "checkout", target: "test" },
  { id: "3", source: "lint", target: "build" },
  { id: "4", source: "test", target: "build" },
  { id: "5", source: "test", target: "e2e" },
];
const order = readingOrder(graph, absolutePositions(graph));

test("tab goes through nodes column by column, cycling", () => {
  expect(order.map((n) => n.id)).toEqual(["checkout", "lint", "test", "build", "e2e"]);
  expect(cycle(order, "test", 1)).toBe("build");
  expect(cycle(order, "e2e", 1)).toBe("checkout");
  expect(cycle(order, undefined, -1)).toBe("e2e");
});

test("] and [ follow edges; } and { move among siblings", () => {
  expect(follow(edges, order, "checkout", "down")).toBe("lint");
  expect(follow(edges, order, "build", "up")).toBe("lint");
  expect(follow(edges, order, "e2e", "down")).toBeUndefined();
  expect(sibling(edges, order, "lint", 1)).toBe("test");
  expect(sibling(edges, order, "build", 1)).toBe("e2e");
  expect(sibling(edges, order, "checkout", 1)).toBeUndefined();
});

test("the nearest node on a side prefers what is in line", () => {
  expect(nearest(order, "checkout", "right")).toBe("lint");
  expect(nearest(order, "test", "right")).toBe("build");
  expect(nearest(order, "lint", "bottom")).toBe("test");
  expect(nearest(order, "checkout", "left")).toBeUndefined();
});
