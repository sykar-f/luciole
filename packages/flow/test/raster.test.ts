/**
 * @luciole/flow draws edges on the cell grid: these frames are what a terminal shows
 * under the nodes (the nodes themselves are OpenTUI boxes, not part of the grid).
 */
import { expect, test } from "bun:test";
import { composeFrame, hitTest } from "../src/frame.ts";
import { drawEdge, drawMiniMap, Grid, pathCells } from "../src/raster.ts";
import type { Edge, Node } from "../src/types.ts";

// Three 5×3 nodes: a on the left, b above right, c below right.
const nodes: Node[] = [
  { id: "a", position: { x: 0, y: 2 }, data: { label: "a" }, width: 5, height: 3 },
  { id: "b", position: { x: 14, y: 0 }, data: { label: "b" }, width: 5, height: 3 },
  { id: "c", position: { x: 14, y: 5 }, data: { label: "c" }, width: 5, height: 3 },
];
const frameOf = (edges: Edge[]) =>
  composeFrame({
    size: { width: 22, height: 9 },
    viewport: { x: 1, y: 0, zoom: 1 },
    nodes,
    edges,
    measured: new Map(),
  });

test("two smoothstep edges from one handle share their first cells and fork", () => {
  const frame = frameOf([
    { id: "ab", source: "a", target: "b" },
    { id: "ac", source: "a", target: "c", label: "go" },
  ]);
  expect(frame.grid.lines()).toEqual([
    "",
    "          ╭───▶",
    "          │",
    "      ────┤",
    "          │",
    "         go",
    "          ╰───▶",
    "",
    "",
  ]);
  // The fork belongs to the last edge drawn; the label to its edge.
  expect(hitTest(frame, { x: 10, y: 5 })).toEqual({ kind: "edge", id: "ac" });
  expect(hitTest(frame, { x: 2, y: 3 })).toMatchObject({ kind: "node", node: { id: "a" } });
  expect(hitTest(frame, { x: 6, y: 3 })).toMatchObject({ kind: "handle", anchor: { nodeId: "a" } });
  expect(hitTest(frame, { x: 20, y: 8 })).toEqual({ kind: "pane" });
});

test("edges that cross merge into ┼, and markers point into their node", () => {
  const grid = new Grid(12, 7);
  const vertical = { x: 5, y: 0 };
  drawEdge(grid, {
    id: "v",
    style: "step",
    source: vertical,
    sourcePosition: "bottom",
    target: { x: 5, y: 6 },
    targetPosition: "top",
  });
  drawEdge(grid, {
    id: "h",
    style: "step",
    source: { x: 0, y: 3 },
    sourcePosition: "right",
    target: { x: 11, y: 3 },
    targetPosition: "left",
  });
  expect(grid.resolve().lines()).toEqual([
    "     │",
    "     │",
    "     │",
    "─────┼─────▶",
    "     │",
    "     │",
    "     ▼",
  ]);
});

test("an animated edge is dashed, and its runners move toward the target", () => {
  const frames = [0, 1].map((phase) => {
    const grid = new Grid(12, 1);
    drawEdge(grid, {
      id: "x",
      style: "step",
      source: { x: 0, y: 0 },
      sourcePosition: "right",
      target: { x: 11, y: 0 },
      targetPosition: "left",
      animated: true,
    });
    return grid.resolve(phase).lines()[0];
  });
  expect(frames).toEqual(["━╌╌╌━╌╌╌━╌╌▶", "╌━╌╌╌━╌╌╌━╌▶"]);
});

test("a bezier edge is drawn in braille, from handle to arrow", () => {
  const grid = new Grid(14, 5);
  drawEdge(grid, {
    id: "z",
    style: "bezier",
    source: { x: 0, y: 0 },
    sourcePosition: "right",
    target: { x: 13, y: 4 },
    targetPosition: "left",
  });
  expect(grid.resolve().lines()).toEqual([
    "⠠⠤⠤⣄",
    "    ⠙⢦⡀",
    "      ⠙⣄",
    "       ⠈⠳⣄",
    "          ⠙⠒⠒▶",
  ]);
});

test("without braille, a bezier edge falls back to box characters", () => {
  const frame = composeFrame({
    size: { width: 22, height: 9 },
    viewport: { x: 1, y: 0, zoom: 1 },
    nodes,
    edges: [{ id: "ab", source: "a", target: "b", type: "bezier" }],
    measured: new Map(),
    braille: false,
  });
  expect(frame.grid.lines().join("\n")).not.toMatch(/[⠀-⣿]/);
  expect(frame.grid.lines()[1]).toBe("          ╭───▶");
});

test("a custom edge type routes through its own corner points", () => {
  const frame = composeFrame({
    size: { width: 22, height: 9 },
    viewport: { x: 1, y: 0, zoom: 1 },
    nodes,
    edges: [{ id: "ac", source: "a", target: "c", type: "down-first" }],
    measured: new Map(),
    edgeTypes: {
      "down-first": ({ source, target }) => [source, { x: source.x, y: target.y }, target],
    },
  });
  expect(frame.grid.lines().slice(3, 7)).toEqual([
    "      ┐",
    "      │",
    "      │",
    "      └───────▶",
  ]);
});

test("the background fills the empty cells, following the viewport", () => {
  const frame = composeFrame({
    size: { width: 12, height: 4 },
    viewport: { x: 1, y: 1, zoom: 1 },
    nodes: [],
    edges: [],
    measured: new Map(),
    background: { variant: "dots", gap: { x: 4, y: 2 } },
  });
  expect(frame.grid.lines()).toEqual(["", " ·   ·   ·", "", " ·   ·   ·"]);
});

test("the minimap draws nodes and the view's outline in braille", () => {
  const grid = new Grid(8, 2);
  const toWorld = drawMiniMap(
    grid,
    { x: 0, y: 0, width: 32, height: 8 },
    [
      { rect: { x: 0, y: 0, width: 8, height: 4 }, role: "edge" },
      { rect: { x: 24, y: 4, width: 8, height: 4 }, role: "edge" },
    ],
    { x: 0, y: 0, width: 16, height: 8 },
  );
  expect(grid.lines()).toEqual(["⣿⣿⠉⢹", "⣇⣀⣀⣸  ⣿⣿"]);
  // Its last cell is the far corner of the world.
  const corner = toWorld({ x: 7, y: 1 });
  expect(Math.round(corner.x)).toBe(30);
  expect(Math.round(corner.y)).toBe(6);
});

test("an orthogonal path goes through every cell between its corners", () => {
  expect(
    pathCells([
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
    ]),
  ).toEqual([
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 2, y: 0 },
    { x: 2, y: 1 },
    { x: 2, y: 2 },
  ]);
});
