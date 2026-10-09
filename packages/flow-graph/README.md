# @luciole-sh/flow-graph

`@luciole-sh/flow-graph` draws node graphs in your terminal, with the names and the shape of
[React Flow](https://reactflow.dev). It is published on npm, and it renders through
[OpenTUI](https://github.com/anomalyco/opentui).

## Install

It runs on Node 26.4 or newer, the version OpenTUI needs, or on Bun 1.3 or newer. The package
has no dependency of its own. React and OpenTUI are peers, so your project keeps one copy of
each.

```sh
bun add @luciole-sh/flow-graph @opentui/core @opentui/keymap @opentui/react react
```

The package is ESM only and ships its type declarations.

## Run a first graph

In an empty project, add this `tsconfig.json`. It compiles JSX for OpenTUI.

```json
{
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "jsxImportSource": "@opentui/react",
    "strict": true,
    "noEmit": true
  }
}
```

Save this program as `main.tsx`, then run `bun main.tsx`. <kbd>Ctrl</kbd>+<kbd>C</kbd> quits.

```tsx
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
```

The first frame is already fitted to your terminal:

```text


    ·       ·       ·       ·       ·       ·       ·       ·       ·



    ·       ·       ·       ·   ╭──────╮    ·       ·       ·       ·
                            ╭──▶│ lint │──────╮
                            │   ╰──────╯      │
            ╔══════════╗    │                 │     ┏━━━━━━━┓
    ·       ║ checkout ║────┤       ·       · ╰────▶┃ build ┃       ·
            ╚══════════╝    │                       ┗━━━━━━━┛
                          fast  ╭──────╮        ⡤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠤⢤
                            ╰──▶│ test │        ⡇                      ⢸
    ·       ·       ·       ·   ╰──────╯    ·   ⡇         ⢠⣤⣤⡄         ⢸
                                                ⡇   ⣤⣤⣤⣤  ⠸⠿⠿⠇   ⣤⣤⣤⡄  ⢸
                                                ⡇   ⠿⠿⠿⠿  ⢠⣤⣤⡄   ⠿⠿⠿⠇  ⢸
                                                ⡇         ⠸⠿⠿⠇         ⢸
    ·       ·       ·       ·       ·       ·   ⡇                      ⢸
 +   -   fit  full                              ⠓⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠚
```

_The program above, in a 72×20 terminal. The frame is captured from a real PTY by
[`website/scripts/capture.py`](https://github.com/sykar-f/luciole/blob/v0.2.0/website/scripts/capture.py)
(`python3 website/scripts/capture.py flow-graph`), and the program is
[`example/main.tsx`](https://github.com/sykar-f/luciole/blob/v0.2.0/packages/flow-graph/example/main.tsx)._

The graph is yours to edit. Drag a node, or select one and move it with the keys below.
Drag from the dot on a selected node to connect it to another node.

### Run the example from a clone

The same program is in the repository, in `packages/flow-graph/example/`. From the root of a
clone, run:

```sh
bun install
bun packages/flow-graph/example/main.tsx
```

`bun run check` type-checks that program, and `tests/readme-examples.test.ts` fails when this
page and the file differ. The same test type-checks every other example of this page.

## Use it in a luciole app

In a luciole app, use `<Flow>` in a Client Component. Pan, zoom, drag and selection stay on
the Client. Only what your app sends, such as a Server Function called from `onNodesChange`
or `onConnect`, reaches the Server.

[`examples/flow`](https://github.com/sykar-f/luciole/tree/v0.2.0/examples/flow) is a full app: a
CI pipeline editor with custom nodes, a side panel and live runs on the Server. The framework's
documentation is at <https://luciole.sh/docs/>.

## Components

Every name on this page is imported from `@luciole-sh/flow-graph`. Coordinates are terminal
cells: `x` counts columns and `y` counts rows. Colours are `#rrggbb` strings.

### `<Flow>`

The canvas. It is controlled: you own `nodes` and `edges`, and the canvas proposes changes
through `onNodesChange` and `onEdgesChange`. Without these callbacks, nodes stay where they are.

| Prop               | Type                                 | Default                   | Meaning                                                                  |
| ------------------ | ------------------------------------ | ------------------------- | ------------------------------------------------------------------------ |
| `nodes`            | `N[]`                                | required                  | The nodes.                                                               |
| `edges`            | `E[]`                                | required                  | The edges.                                                               |
| `onNodesChange`    | `(changes: NodeChange<N>[]) => void` |                           | Receives drags, selections and removals. Pass it to `applyNodeChanges`.  |
| `onEdgesChange`    | `(changes: EdgeChange<E>[]) => void` |                           | The same for edges.                                                      |
| `onConnect`        | `(connection: Connection) => void`   |                           | A connection made from a handle, or with the keyboard.                   |
| `onNodeClick`      | `(node: N) => void`                  |                           | A click on a node.                                                       |
| `onEdgeClick`      | `(edge: E) => void`                  |                           | A click on an edge.                                                      |
| `onPaneClick`      | `(at: XY) => void`                   |                           | A click on the empty canvas, in flow coordinates.                        |
| `onNodeDragStop`   | `(nodes: N[]) => void`               |                           | The end of a mouse drag, with the moved nodes at their new positions.    |
| `onViewportChange` | `(viewport: Viewport) => void`       |                           | The view moved or zoomed.                                                |
| `nodeTypes`        | `Record<string, NodeComponent<N>>`   |                           | Your node components, by `node.type`.                                    |
| `edgeTypes`        | `Record<string, EdgeType>`           |                           | Your edge styles and routes, by `edge.type`.                             |
| `defaultEdgeType`  | `string`                             | `"smoothstep"`            | The type of an edge that names none.                                     |
| `fitView`          | `boolean`                            | `false`                   | Fits every node in view once the canvas has a size.                      |
| `defaultViewport`  | `Viewport`                           | `{ x: 2, y: 1, zoom: 1 }` | The first view.                                                          |
| `keyboard`         | `boolean`                            | `true`                    | Turns the key bindings off while a field elsewhere takes the keys.       |
| `braille`          | `boolean`                            | `true`                    | Draws curves in braille. When `false`, curves are drawn as `smoothstep`. |
| `theme`            | `Partial<FlowTheme>`                 | `defaultTheme`            | Overrides colours of the canvas.                                         |
| `id`               | `string`                             |                           | A name for the canvas.                                                   |
| `children`         | `ReactNode`                          |                           | `<Background>`, `<MiniMap>`, `<Controls>` and `<Panel>`.                 |

`FlowProps<N, E>` is the type of these props. `N` extends `Node` and `E` extends `Edge`, so
the callbacks receive your own node and edge types:

```tsx
import { Flow, type FlowProps, type Node } from "@luciole-sh/flow-graph";

type Step = Node<{ label: string; command: string }>;

export function Steps({ nodes, edges }: Pick<FlowProps<Step>, "nodes" | "edges">) {
  return (
    <Flow nodes={nodes} edges={edges} onNodeClick={(step) => console.log(step.data.command)} />
  );
}
```

`<Flow>` raises no error of its own. A node of an unknown `type` is drawn as a `default` node,
and an edge of an unknown `type` as a `smoothstep` edge.

### `<Background>`

Marks every `gap` flow cells, under the edges.

| Prop      | Type                | Default            | Meaning                  |
| --------- | ------------------- | ------------------ | ------------------------ |
| `variant` | `BackgroundVariant` | `"dots"`           | The mark.                |
| `gap`     | `XY`                | `{ x: 8, y: 4 }`   | The spacing, in cells.   |
| `color`   | `string`            | the theme's colour | The colour of the marks. |

`BackgroundVariant` is `"dots"`, `"lines"` or `"cross"`.

### `<Controls>`

Zoom in, zoom out, fit the view, and show the current level.

| Prop       | Type            | Default         | Meaning                        |
| ---------- | --------------- | --------------- | ------------------------------ |
| `position` | `PanelPosition` | `"bottom-left"` | The corner or edge it sits on. |

### `<MiniMap>`

Every node in braille, with the part in view outlined. A click on it centres the view there.

| Prop       | Type            | Default          | Meaning                |
| ---------- | --------------- | ---------------- | ---------------------- |
| `position` | `PanelPosition` | `"bottom-right"` | Where it sits.         |
| `width`    | `number`        | `24`             | Its width, in columns. |
| `height`   | `number`        | `8`              | Its height, in rows.   |

### `<Panel>`

Your own content over the canvas. A click on a panel does not select or pan the canvas.

| Prop       | Type            | Default      | Meaning        |
| ---------- | --------------- | ------------ | -------------- |
| `position` | `PanelPosition` | `"top-left"` | Where it sits. |
| `children` | `ReactNode`     | required     | What it shows. |

`PanelPosition` is `"top-left"`, `"top-center"`, `"top-right"`, `"bottom-left"`,
`"bottom-center"` or `"bottom-right"`.

### `<FlowProvider>`

Shares one canvas with components outside `<Flow>`, such as a side panel that calls `fitView`.
Wrap the panel and the `<Flow>` in it. Without it, `<Flow>` keeps its own state.

| Prop              | Type        | Default                   | Meaning                               |
| ----------------- | ----------- | ------------------------- | ------------------------------------- |
| `children`        | `ReactNode` | required                  | The panel and the `<Flow>`.           |
| `defaultViewport` | `Viewport`  | `{ x: 2, y: 1, zoom: 1 }` | The first view.                       |
| `fitView`         | `boolean`   | `false`                   | Fits every node in view at the start. |

`<Background>`, `<Controls>`, `<MiniMap>` and `<Handle>` read the canvas they belong to.
Rendered outside a `<Flow>` or a `<FlowProvider>`, they throw
`useFlow and the canvas components need a <Flow> or <FlowProvider>`.

## Nodes and edges

### `Node`

A node as your app keeps it. `Node<Data>` types its `data`, which defaults to
`Record<string, unknown>`.

| Field                                    | Type       | Default     | Meaning                                                                              |
| ---------------------------------------- | ---------- | ----------- | ------------------------------------------------------------------------------------ |
| `id`                                     | `string`   | required    | Unique among the nodes.                                                              |
| `position`                               | `XY`       | required    | Its top-left cell, relative to its parent's when it has `parentId`.                  |
| `data`                                   | `Data`     | required    | Your data. The built-in nodes show `data.label`, or the `id` without one.            |
| `type`                                   | `string`   | `"default"` | A key of `nodeTypes`, or `default`, `input`, `output` or `group`.                    |
| `selected`, `dragging`, `hidden`         | `boolean`  | `false`     | Set by the changes you apply. A hidden node is not drawn.                            |
| `parentId`                               | `string`   |             | The `group` node it sits in.                                                         |
| `width`, `height`                        | `number`   | measured    | A fixed size in cells. A `group` node needs both.                                    |
| `sourcePosition`                         | `Position` | `"right"`   | Where its edges leave, when it has no `<Handle>`.                                    |
| `targetPosition`                         | `Position` | `"left"`    | Where its edges arrive, when it has no `<Handle>`.                                   |
| `draggable`, `selectable`, `connectable` | `boolean`  | `true`      | Whether you can drag it, select it, or start a connection from it.                   |
| `zIndex`                                 | `number`   | `0`         | Its drawing order. A group is drawn under its children, the selection over the rest. |
| `color`                                  | `string`   | the theme's | Its colour where the canvas draws it itself: a dot when zoomed out, the minimap.     |

`Position` is the side of a node: `"left"`, `"right"`, `"top"` or `"bottom"`. `XY` is
`{ x, y }`, and `Rect` is `{ x, y, width, height }`, both in cells.

### `Edge`

An edge from a source node to a target node. `Edge<Data>` types its `data`.

| Field                          | Type             | Default           | Meaning                                                                |
| ------------------------------ | ---------------- | ----------------- | ---------------------------------------------------------------------- |
| `id`                           | `string`         | required          | Unique among the edges.                                                |
| `source`, `target`             | `string`         | required          | The ids of the nodes it joins.                                         |
| `sourceHandle`, `targetHandle` | `string \| null` | the first handle  | The `id` of a `<Handle>`, or the node's first handle of that type.     |
| `type`                         | `string`         | `defaultEdgeType` | A key of `edgeTypes`, or `smoothstep`, `step`, `straight` or `bezier`. |
| `label`                        | `string`         |                   | Text drawn on the edge.                                                |
| `animated`                     | `boolean`        | `false`           | Dashes that run from the source to the target.                         |
| `selected`, `hidden`           | `boolean`        | `false`           | Set by the changes you apply. A hidden edge is not drawn.              |
| `markerEnd`                    | `MarkerType`     | `"arrow"`         | The mark where it reaches the target.                                  |
| `markerStart`                  | `MarkerType`     | `"none"`          | The mark where it leaves the source.                                   |
| `color`                        | `string`         | the theme's       | The colour of its line.                                                |
| `data`                         | `Data`           |                   | Your data.                                                             |

`MarkerType` is `"arrow"` or `"none"`.

### `Connection`

What `onConnect` receives: `{ source, target, sourceHandle, targetHandle }`. The handles are
`string | null`, and `null` stands for the node's default handle. Turn a connection into an edge
with `addEdge`.

## Apply the canvas's changes

The canvas never edits your nodes. It sends `NodeChange` and `EdgeChange` objects, and you
apply the ones you accept with `applyNodeChanges` and `applyEdgeChanges`.

| Change                 | Shape                                                       | Who sends it                                                                                       |
| ---------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `NodePositionChange`   | `{ id, type: "position", position?, dragging? }`            | The canvas. A drag sends `dragging: true`, then `false` at the drop. A key move has no `dragging`. |
| `SelectionChange`      | `{ id, type: "select", selected }`                          | The canvas, on a click or a key, and `select()`.                                                   |
| `RemoveChange`         | `{ id, type: "remove" }`                                    | The canvas, on `x` or `Delete`, and `deleteElements()`.                                            |
| `NodeDimensionsChange` | `{ id, type: "dimensions", dimensions: { width, height } }` | Never the canvas. `applyNodeChanges` leaves the node as it is.                                     |
| `AddChange<T>`         | `{ type: "add", item, index? }`                             | Your app. The item goes in at `index`, or at the end.                                              |
| `ReplaceChange<T>`     | `{ id, type: "replace", item }`                             | Your app. The item takes the place of the element `id`.                                            |

`NodeChange<N>` is any of the six, with `N` in `add` and `replace`. `EdgeChange<E>` is
`SelectionChange`, `RemoveChange`, `AddChange<E>` or `ReplaceChange<E>`.

This handler applies every change, and saves positions only when a drag ends or a key moves
a node:

```ts
import {
  applyNodeChanges,
  type Node,
  type NodeChange,
  type NodePositionChange,
} from "@luciole-sh/flow-graph";

export function onNodesChange(
  changes: NodeChange[],
  nodes: Node[],
  save: (moves: NodePositionChange[]) => void,
): Node[] {
  const moves = changes.filter(
    (change): change is NodePositionChange =>
      change.type === "position" && change.dragging !== true,
  );
  if (moves.length > 0) save(moves);
  return applyNodeChanges(changes, nodes);
}
```

Your app sends its own changes through the same function:

```ts
import { applyNodeChanges, type Node, type NodeChange } from "@luciole-sh/flow-graph";

export const withDeploy = (nodes: Node[]): Node[] => {
  const changes: NodeChange[] = [
    { type: "add", item: { id: "deploy", position: { x: 60, y: 3 }, data: { label: "deploy" } } },
    { type: "remove", id: "lint" },
  ];
  return applyNodeChanges(changes, nodes);
};
```

## Write your own nodes

### `NodeComponent` and `NodeProps`

A node type is a `NodeComponent<N>`: a function component of `NodeProps<N>`. Register it in
`nodeTypes` under the name your nodes give in `type`.

| Prop              | Type        | Meaning                                                           |
| ----------------- | ----------- | ----------------------------------------------------------------- |
| `id`              | `string`    | The node's id.                                                    |
| `data`            | `N["data"]` | The node's `data`.                                                |
| `type`            | `string`    | The node's type.                                                  |
| `selected`        | `boolean`   | Whether the node is selected.                                     |
| `dragging`        | `boolean`   | Whether the node is being dragged.                                |
| `detail`          | `Detail`    | The zoom level. At `dot`, the canvas draws the node itself.       |
| `connectTarget`   | `boolean`   | Whether the node is the proposed target of a keyboard connection. |
| `width`, `height` | `number`    | The node's fixed size in cells, when it has one.                  |

`Detail` is `"full"`, `"compact"` or `"dot"`: what a node shows at each zoom level. The
built-in `DefaultNode` draws `default`, `input` and `output`, and `GroupNode` draws `group`.
Wrap or reuse them in your own `nodeTypes`.

### `<Handle>`

Declares where a custom node's edges attach. Render one per attachment point. A handle draws
nothing itself. The canvas marks the sources of the selected node, and the targets while you
connect. Handles that share a side are spread along it, in render order.

| Prop       | Type             | Default  | Meaning                                                  |
| ---------- | ---------------- | -------- | -------------------------------------------------------- |
| `type`     | `HandleType`     | required | Whether edges leave or arrive here.                      |
| `position` | `Position`       | required | The side of the node.                                    |
| `id`       | `string \| null` | `null`   | Names the handle, for `sourceHandle` and `targetHandle`. |

`HandleType` is `"source"` or `"target"`. A `<Handle>` outside a node component does nothing.

This node shows a job's status and sends an edge from one of two handles:

```tsx
import { Handle, type Node, type NodeComponent } from "@luciole-sh/flow-graph";

type Job = Node<{ label: string; failed: boolean }>;

export const JobNode: NodeComponent<Job> = ({ data, selected, detail }) =>
  detail === "compact" ? (
    <text selectable={false}>{data.label}</text>
  ) : (
    <box border borderStyle={selected ? "double" : "rounded"} paddingX={1}>
      <text selectable={false}>{`${data.failed ? "✗" : "✓"} ${data.label}`}</text>
      <Handle type="target" position="left" />
      <Handle type="source" position="right" id="next" />
      <Handle type="source" position="bottom" id="retry" />
    </box>
  );

export const nodeTypes = { job: JobNode };
```

An edge leaves the bottom when it sets `sourceHandle: "retry"`.

## Draw your own edges

### `EdgeType`, `EdgeStyle` and `EdgeRoute`

An `edgeTypes` entry is an `EdgeType`: an `EdgeStyle` or an `EdgeRoute`.

- `EdgeStyle` is a built-in style: `"smoothstep"`, `"step"`, `"straight"` or `"bezier"`.
- `EdgeRoute` is a function. It receives `{ edge, source, sourcePosition, target, targetPosition }`,
  where `source` and `target` are the anchor cells on the canvas. It returns the corners of the
  path, both ends included.

The canvas draws a route in box characters, like a `step` edge. Two corners that share neither a
row nor a column are joined across, then down.

```ts
import type { EdgeType } from "@luciole-sh/flow-graph";

// Runs two rows under the lower node, then rises to the target.
const under: EdgeType = ({ source, target }) => {
  const floor = Math.max(source.y, target.y) + 2;
  return [source, { x: source.x, y: floor }, { x: target.x, y: floor }, target];
};

export const edgeTypes: Record<string, EdgeType> = { under, curve: "bezier" };
```

## Change the colours

### `FlowTheme`

The canvas's colours. Pass any of them to `<Flow theme>`, and `defaultTheme` gives the others.

| Key          | Default   | Colours                                                                                   |
| ------------ | --------- | ----------------------------------------------------------------------------------------- |
| `text`       | `#e6edf3` | The labels of the built-in nodes, the buttons of `<Controls>`, and a node drawn as a dot. |
| `muted`      | `#8b98a5` | The zoom level that `<Controls>` shows.                                                   |
| `border`     | `#4d5966` | The border of a node.                                                                     |
| `selected`   | `#67d9bc` | A selected node or edge.                                                                  |
| `connect`    | `#f2cc60` | The border of the node proposed as the target of a connection.                            |
| `group`      | `#3b4450` | The frame of a `group` node.                                                              |
| `edge`       | `#6e7c8a` | An edge.                                                                                  |
| `animated`   | `#79c0ff` | An animated edge.                                                                         |
| `label`      | `#c9d1d9` | The label of an edge.                                                                     |
| `labelBg`    | `#1f262e` | The background of an edge label and of the buttons of `<Controls>`.                       |
| `marker`     | `#8b98a5` | The arrows at the ends of edges.                                                          |
| `background` | `#2d353e` | The marks of `<Background>`.                                                              |
| `handle`     | `#f2cc60` | Handles, and the line of a connection being made.                                         |
| `panelBg`    | `#161b22` | The background of the built-in nodes, `<Controls>` and `<MiniMap>`.                       |

```ts
import { defaultTheme, type FlowTheme } from "@luciole-sh/flow-graph";

export const light: FlowTheme = {
  ...defaultTheme,
  text: "#1f2328",
  labelBg: "#f6f8fa",
  panelBg: "#ffffff",
};
```

## Hooks and helpers

### `useNodesState` and `useEdgesState`

`useNodesState(initial)` returns `[nodes, setNodes, onNodesChange]`. It is `useState`, plus the
callback that applies the canvas's changes. `useEdgesState(initial)` does the same for edges.
The program at the top of this page uses both.

### `useFlow()` and `FlowInstance`

`useFlow()` returns the `FlowInstance` of the canvas around it, inside `<Flow>` or
`<FlowProvider>`. Elsewhere it throws
`useFlow and the canvas components need a <Flow> or <FlowProvider>`.

| Member                                   | What it does                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| `getNodes()`, `getEdges()`               | The nodes and edges the canvas last received.                             |
| `getNode(id)`                            | One node, or `undefined`.                                                 |
| `getViewport()`, `setViewport(viewport)` | Read or set the view.                                                     |
| `fitView()`                              | The closest zoom level at which every node is seen, centred.              |
| `zoomIn()`, `zoomOut()`                  | One zoom level in or out, around the centre.                              |
| `setCenter(point, zoom?)`                | Centres the view on a flow point, at `zoom` or the current level.         |
| `reveal(id)`                             | Pans just enough to show node `id` whole.                                 |
| `select({ nodes, edges })`               | Proposes selecting exactly these ids, through the change callbacks.       |
| `deleteElements({ nodes, edges })`       | Proposes removing these ids. A node takes its edges and children with it. |
| `center()`                               | The flow point at the centre of the view.                                 |

```tsx
import { useFlow, type FlowInstance } from "@luciole-sh/flow-graph";

export function FitButton() {
  const flow: FlowInstance = useFlow();
  return <text onMouseDown={() => flow.fitView()}>fit</text>;
}
```

`useViewport()` returns the current `{ x, y, zoom, detail }` and re-renders when it changes. It
throws the same error outside a canvas.

### `addEdge` and `getEdgeId`

`addEdge(connection, edges, getId?)` returns a new array with an edge for `connection`. The
array is unchanged when an edge joins the same nodes and handles, or when `source` or `target`
is empty. The new edge keeps the connection's `id`, or takes `getId(connection)`.

`getEdgeId(connection)` is the default `getId`. It returns
`xy-edge__<source><sourceHandle>-<target><targetHandle>`, with an empty string for a `null`
handle.

```ts
import { addEdge, getEdgeId, type Edge } from "@luciole-sh/flow-graph";

const connection = { source: "lint", target: "build", sourceHandle: null, targetHandle: null };
getEdgeId(connection); // "xy-edge__lint-build"
export const edges: Edge[] = addEdge({ ...connection, animated: true }, []);
```

### `applyNodeChanges` and `applyEdgeChanges`

`applyNodeChanges(changes, nodes)` returns a new array. A node without a change keeps its
identity, and a changed node is a copy. `applyEdgeChanges(changes, edges)` does the same for
edges. Neither raises an error. A change for an unknown id is ignored. See
[Apply the canvas's changes](#apply-the-canvass-changes).

### `ZOOMS` and `detailFor`

`ZOOMS` is `[1, 0.5, 0.25]`, the three zoom levels. `detailFor(zoom)` returns the `Detail` drawn
at a zoom: `full` from 1, `compact` from 0.5, `dot` below.

```ts
import { detailFor } from "@luciole-sh/flow-graph";

detailFor(0.5); // "compact"
```

### `flowBounds` and `fitViewport`

`flowBounds(nodes, measured)` returns the `Rect` around the visible nodes, in flow cells, or
`null` when there is none. `measured` maps node ids to measured sizes. Pass `new Map()` to use
the sizes of the built-in nodes.

`fitViewport(bounds, canvas, padding?)` returns the `Viewport` that centres `bounds` in a canvas
of `{ width, height }` cells. It picks the closest level of `ZOOMS` at which `bounds` fits
inside `padding` cells, 2 by default. Its zoom is ¼ when nothing fits, and 1 when `bounds` is
`null`.

```ts
import { fitViewport, flowBounds, type Node } from "@luciole-sh/flow-graph";

const nodes: Node[] = [
  { id: "checkout", position: { x: 0, y: 3 }, data: { label: "checkout" } },
  { id: "build", position: { x: 40, y: 3 }, data: { label: "build" } },
];
const bounds = flowBounds(nodes, new Map()); // { x: 0, y: 3, width: 49, height: 3 }
fitViewport(bounds, { width: 80, height: 24 }); // { x: 16, y: 8, zoom: 1 }
```

### `composeFrame`, `hitTest`, `Grid` and `Frame`

The frame under the nodes, as pure functions, for tests and for rendering off the canvas.

- `composeFrame(input)` returns a `Frame`: `{ grid, placed, anchors }`. It draws the edges,
  their labels and the background. It takes `size`, `viewport`, `nodes`, `edges` and
  `measured`, plus the optional `handles`, `background`, `connecting`, `edgeTypes`,
  `defaultEdgeType`, `braille` and `phase`.
- `handles` maps a node id to its `HandleSpec`s, each `{ id, type, position }` as a `<Handle>`
  declares it.
- `Grid` holds the cells: `lines()` returns its rows as text, and `get(x, y)` returns one cell.
- `hitTest(frame, at)` returns what is at a canvas cell. Its `kind` is `"handle"` with the
  `anchor`, `"node"` with the `node`, `"edge"` with the edge's `id`, or `"pane"`.

```ts
import { composeFrame, hitTest, type Node } from "@luciole-sh/flow-graph";

const nodes: Node[] = [
  { id: "a", position: { x: 0, y: 0 }, data: { label: "a" } },
  { id: "b", position: { x: 16, y: 0 }, data: { label: "b" } },
];
const frame = composeFrame({
  size: { width: 24, height: 3 },
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes,
  edges: [{ id: "a-b", source: "a", target: "b", label: "go" }],
  measured: new Map(),
});
frame.grid.lines()[1]; // "        ── go ─▶"
hitTest(frame, { x: 10, y: 1 }); // { kind: "edge", id: "a-b" }
```

## What differs from React Flow

- **Cell coordinates.** A row is about twice as tall as a column is wide.
- **Semantic zoom.** `ZOOMS` has three levels: 1, ½ and ¼. Zooming out moves nodes closer and
  draws less of each: the node's component (`full`), its label on one row (`compact`), then a
  dot in `node.color` (`dot`).
- **Edges on the grid.** `smoothstep` (the default) and `step` use box characters, and the
  lines of every edge in a cell merge into `├ ┤ ┬ ┴ ┼`. `bezier` and slanted `straight` edges use
  braille. `animated` edges draw dashes that move toward the target.
- **Edge types.** An `edgeTypes` entry is a built-in style, or a function that returns the
  corners of the path (`EdgeRoute`). There is no free render component, as SVG gives React Flow.
- **Node types.** `default` has a rounded border, `input` a double one, `output` a thick one,
  and `group` a frame of fixed size whose children set `parentId`. Without a `<Handle>`, a node
  takes edges on its left and sends them from its right.
- **Text in custom nodes.** Set `selectable={false}` on it. Otherwise a click starts a text
  selection instead of a drag.

## Keyboard and mouse

The keys belong to the group `flow`. Set `keyboard={false}` to turn them off. They run
through `@opentui/keymap`: inside an app with its own `<KeymapProvider>`, such as a luciole app,
they join its layers, and `<KeyHelp>` lists them. Elsewhere the canvas installs its own keymap.

| Keys                               | Action                                                           |
| ---------------------------------- | ---------------------------------------------------------------- |
| `h j k l`, arrows                  | Move the view                                                    |
| `H J K L`, <kbd>Shift</kbd>+arrows | Move the selected nodes by one cell                              |
| `tab`, <kbd>Shift</kbd>+`tab`      | Next, previous node, by column from left to right                |
| `]`, `[`                           | Follow an edge downstream, upstream                              |
| `}`, `{`                           | Next, previous sibling node                                      |
| `c`, then `tab` or `]`, `Enter`    | Connect the selected node to the proposed target (`Esc` cancels) |
| `e`                                | Select the node's edges in turn                                  |
| `x`, `Delete`                      | Delete the selection. A node takes its edges with it             |
| `=` or `+`, `-`, `0`               | Zoom in, zoom out, fit everything                                |
| `Esc`                              | Clear the selection                                              |

With the mouse:

- A click selects. <kbd>Shift</kbd>+click adds to the selection.
- Dragging a node moves it, with the other selected nodes.
- Dragging the background moves the view.
- Dragging from a handle (`●`, shown on the selected node) to a node connects them.
- The wheel moves the view, horizontally with <kbd>Shift</kbd>. <kbd>Ctrl</kbd> or <kbd>Alt</kbd> and the wheel zoom.
- A click in the minimap centres the view there.

## Limits

- The package is 0.x. Until 1.0, a minor release may break the API.
- It is tested on Bun only. The `bun` export condition points to the TypeScript sources.
- Zoom has three fixed levels, because a terminal cannot scale glyphs.
- Curves need braille glyphs in your terminal's font. Set `braille={false}` where they are missing.
- A `group` node needs a `width` and a `height`.
- Edges are drawn in box characters. They cannot be arbitrary components.
- It does not lay nodes out for you. You give every node a `position`.

## Origin of the code

The orthogonal routing of edges, the bezier control points and the application of changes come
from xyflow (MIT), in [`src/vendor/xyflow`](https://github.com/sykar-f/luciole/blob/v0.2.0/packages/flow-graph/src/vendor/xyflow/README.md). Rendering and
interaction are the package's own.

## Licence

MIT.
