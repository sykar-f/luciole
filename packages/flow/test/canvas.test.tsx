/**
 * `<Flow>` rendered by OpenTUI: the mouse and the keyboard change the application's
 * nodes and edges through `onNodesChange`/`onEdgesChange`/`onConnect`, as React Flow's do.
 */
import { afterEach, expect, test } from "bun:test";
import { act, useEffect, useState, type ReactNode } from "react";
import { useRenderer } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider, useActiveKeys } from "@opentui/keymap/react";
import {
  addEdge,
  Background,
  Controls,
  Flow,
  MiniMap,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
} from "../src/index.ts";

/** The application's own keymap, as luciole's Shell installs one. */
function Keys({ children }: { children: ReactNode }) {
  const renderer = useRenderer();
  const [keymap] = useState(() => createDefaultOpenTuiKeymap(renderer));
  return <KeymapProvider keymap={keymap}>{children}</KeymapProvider>;
}

/** What a help line of the application sees: the described keys of group `flow`. */
const help: { keys: string[] } = { keys: [] };
function Help() {
  const keys = useActiveKeys({ includeMetadata: true });
  useEffect(() => {
    help.keys = keys.flatMap((k) => (k.bindingAttrs?.group === "flow" ? [k.display] : []));
  }, [keys]);
  return null;
}

const NODES: Node[] = [
  { id: "a", position: { x: 0, y: 3 }, data: { label: "checkout" }, type: "input" },
  { id: "b", position: { x: 20, y: 0 }, data: { label: "lint" } },
  { id: "c", position: { x: 20, y: 6 }, data: { label: "test" } },
  { id: "d", position: { x: 36, y: 3 }, data: { label: "build" }, type: "output" },
];
const EDGES: Edge[] = [
  { id: "ab", source: "a", target: "b" },
  // Not animated: its timer would update state outside act() (raster.test.ts covers the
  // dashes).
  { id: "ac", source: "a", target: "c", label: "go" },
  { id: "bd", source: "b", target: "d" },
];

const state: { nodes: Node[]; edges: Edge[] } = { nodes: [], edges: [] };
function App({ provider }: { provider: boolean }) {
  const [nodes, , onNodesChange] = useNodesState(NODES);
  const [edges, setEdges, onEdgesChange] = useEdgesState(EDGES);
  useEffect(() => {
    state.nodes = nodes;
    state.edges = edges;
  }, [nodes, edges]);
  const flow = (
    <Flow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={(c) => setEdges((current) => addEdge(c, current))}
      defaultViewport={{ x: 1, y: 1, zoom: 1 }}
    >
      <Background />
      <Controls />
      <MiniMap width={12} height={3} />
    </Flow>
  );
  return provider ? (
    <Keys>
      <Help />
      {flow}
    </Keys>
  ) : (
    flow
  );
}

let destroy: (() => void) | undefined;
afterEach(() => act(() => destroy?.()));

// Without the application's keymap by default: the canvas brings its own.
async function open({ provider = false }: { provider?: boolean } = {}) {
  const ui = await testRender(<App provider={provider} />, { width: 60, height: 14 });
  destroy = () => ui.renderer.destroy();
  const settle = async () => {
    for (let i = 0; i < 3; i++)
      await act(async () => {
        await ui.renderOnce();
      });
  };
  const run = async (action: () => unknown) => {
    await act(async () => {
      await action();
    });
    await settle();
  };
  await settle();
  const selected = () => state.nodes.filter((n) => n.selected).map((n) => n.id);
  return { ui, run, selected, frame: () => ui.captureCharFrame() };
}

test("nodes, edges and panels are drawn", async () => {
  const { frame } = await open();
  expect(frame()).toContain("║ checkout ║");
  expect(frame()).toContain("│ lint │");
  expect(frame()).toContain("┃ build ┃");
  expect(frame()).toContain("─▶│ test │");
  expect(frame()).toContain(" go ");
  expect(frame()).toContain(" +   -   fit  full");
});

test("a click selects a node, a drag moves it, and a click on the pane deselects", async () => {
  const { ui, run, selected } = await open();
  // lint's label is at x 24, y 2 (viewport 1, 1).
  await run(() => ui.mockMouse.click(24, 2));
  expect(selected()).toEqual(["b"]);
  await run(() => ui.mockMouse.drag(24, 2, 27, 3));
  expect(state.nodes.find((n) => n.id === "b")).toMatchObject({
    position: { x: 23, y: 1 },
    dragging: false,
  });
  await run(() => ui.mockMouse.click(30, 10));
  expect(selected()).toEqual([]);
});

test("dragging the pane pans the view", async () => {
  const { ui, run, frame } = await open();
  const before = frame()
    .split("\n")
    .findIndex((line) => line.includes("checkout"));
  await run(() => ui.mockMouse.drag(50, 1, 50, 3));
  expect(
    frame()
      .split("\n")
      .findIndex((line) => line.includes("checkout")),
  ).toBe(before + 2);
});

test("the keyboard selects, follows edges, moves and deletes", async () => {
  const { ui, run, selected } = await open();
  await run(() => ui.mockInput.pressTab());
  expect(selected()).toEqual(["a"]);
  await run(() => ui.mockInput.pressKey("]"));
  expect(selected()).toEqual(["b"]);
  await run(() => ui.mockInput.pressKey("]"));
  expect(selected()).toEqual(["d"]);
  await run(() => ui.mockInput.pressKey("L"));
  expect(state.nodes.find((n) => n.id === "d")?.position).toEqual({ x: 37, y: 3 });
  await run(() => ui.mockInput.pressKey("x"));
  expect(state.nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
  expect(state.edges.map((e) => e.id)).toEqual(["ab", "ac"]);
});

test("c, a target, then Enter connects two nodes with the keyboard", async () => {
  const { ui, run, frame } = await open();
  await run(() => ui.mockInput.pressTab());
  await run(() => ui.mockInput.pressTab());
  await run(() => ui.mockInput.pressTab()); // c: test
  await run(() => ui.mockInput.pressKey("c"));
  // The proposal is the nearest node to the right: build.
  expect(frame()).toContain("○");
  await run(() => ui.mockInput.pressEnter());
  expect(state.edges.at(-1)).toMatchObject({ source: "c", target: "d" });
});

test("zooming out draws labels only, then dots", async () => {
  const { ui, run, frame } = await open();
  await run(() => ui.mockInput.pressKey("-"));
  // Clipped to its full width, halved: labels do not spill over their neighbours.
  expect(frame()).toContain(" chec");
  expect(frame()).not.toContain("checkout");
  expect(frame()).not.toContain("║");
  expect(frame()).toContain("compact");
  await run(() => ui.mockInput.pressKey("-"));
  expect(frame()).toContain("●");
  expect(frame()).not.toContain("checkout");
  await run(() => ui.mockInput.pressKey("0"));
  expect(frame()).toContain("║ checkout ║");
});

test("inside the application's keymap, the canvas's keys join it and its help", async () => {
  const { ui, run, selected } = await open({ provider: true });
  expect(help.keys).toContain("tab");
  await run(() => ui.mockInput.pressTab());
  expect(selected()).toEqual(["a"]);
  expect(help.keys).toContain("]");
});
