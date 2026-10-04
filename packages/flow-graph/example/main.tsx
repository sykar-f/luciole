import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
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
} from "@luciole-sh/flow-graph";

const initialNodes: Node[] = [
  { id: "checkout", type: "input", position: { x: 0, y: 3 }, data: { label: "checkout" } },
  { id: "lint", position: { x: 20, y: 0 }, data: { label: "lint" } },
  { id: "test", position: { x: 20, y: 6 }, data: { label: "test" } },
  { id: "build", type: "output", position: { x: 40, y: 3 }, data: { label: "build" } },
];

const initialEdges: Edge[] = [
  { id: "checkout-lint", source: "checkout", target: "lint" },
  { id: "checkout-test", source: "checkout", target: "test", label: "fast" },
  { id: "lint-build", source: "lint", target: "build" },
];

function Pipeline() {
  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  return (
    <Flow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={(connection) => setEdges((current) => addEdge(connection, current))}
      fitView
    >
      <Background />
      <Controls />
      <MiniMap />
    </Flow>
  );
}

const renderer = await createCliRenderer();
createRoot(renderer).render(<Pipeline />);
