# @luciole-sh/flow-graph

`@luciole-sh/flow-graph` draws node graphs in the terminal, with the names and the shape of
[React Flow](https://reactflow.dev). It is published on npm, and it renders through
[OpenTUI](https://github.com/anomalyco/opentui).

## Install

You need Bun 1.3 or newer. The package has no dependency of its own. React and OpenTUI are
peers, so your project keeps one copy of each.

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

The first frame is already fitted to the terminal:

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
[`website/scripts/capture.py`](../../website/scripts/capture.py) (`python3 website/scripts/capture.py flow-graph`).
The program is [`example/main.tsx`](example/main.tsx), and `bun run check` type-checks it._

The graph is yours to edit. Drag a node, or select one and move it with the keys below.
Drag from the dot on a selected node to connect it to another node.

## Use it in a luciole app

In a luciole app, use `<Flow>` in a Client Component. Pan, zoom, drag and selection stay on
the Client. Only what your app sends, such as a Server Function called from `onNodesChange`
or `onConnect`, reaches the Server.

[`examples/flow`](../../examples/flow) is a full app: a CI pipeline editor with custom nodes,
a side panel and live runs on the Server. The framework's documentation is at
<https://luciole.sh/docs/>.

## Components

Every component below is exported by `@luciole-sh/flow-graph`. Coordinates are terminal
cells: `position.x` counts columns and `position.y` counts rows.

### `<Flow>`

The canvas. It is controlled: you own `nodes` and `edges`, and the canvas proposes changes
through `onNodesChange` and `onEdgesChange`. Without these callbacks, nodes stay where they are.

| Prop               | Type                               | Default        | Meaning                                                                  |
| ------------------ | ---------------------------------- | -------------- | ------------------------------------------------------------------------ |
| `nodes`            | `Node[]`                           | required       | The nodes.                                                               |
| `edges`            | `Edge[]`                           | required       | The edges.                                                               |
| `onNodesChange`    | `(changes: NodeChange[]) => void`  |                | Receives drags, selections and removals. Pass it to `applyNodeChanges`.  |
| `onEdgesChange`    | `(changes: EdgeChange[]) => void`  |                | The same for edges.                                                      |
| `onConnect`        | `(connection: Connection) => void` |                | A connection made from a handle, or with the keyboard.                   |
| `onNodeClick`      | `(node: Node) => void`             |                | A click on a node.                                                       |
| `onEdgeClick`      | `(edge: Edge) => void`             |                | A click on an edge.                                                      |
| `onPaneClick`      | `(at: XY) => void`                 |                | A click on the empty canvas, in flow coordinates.                        |
| `onNodeDragStop`   | `(nodes: Node[]) => void`          |                | The end of a mouse drag, with the moved nodes at their new positions.    |
| `onViewportChange` | `(viewport: Viewport) => void`     |                | The view moved or zoomed.                                                |
| `nodeTypes`        | `Record<string, NodeComponent>`    |                | Your node components, by `node.type`.                                    |
| `edgeTypes`        | `Record<string, EdgeType>`         |                | Your edge styles, by `edge.type`.                                        |
| `defaultEdgeType`  | `string`                           | `smoothstep`   | The type of an edge that names none.                                     |
| `fitView`          | `boolean`                          | `false`        | Fits every node in view once the canvas has a size.                      |
| `defaultViewport`  | `Viewport`                         |                | The first view: `{ x, y, zoom }`.                                        |
| `keyboard`         | `boolean`                          | `true`         | Turns the key bindings off while a field elsewhere takes the keys.       |
| `braille`          | `boolean`                          | `true`         | Draws curves in braille. When `false`, curves are drawn as `smoothstep`. |
| `theme`            | `Partial<FlowTheme>`               | `defaultTheme` | Overrides colours of the canvas.                                         |
| `id`               | `string`                           |                | A name for the canvas.                                                   |
| `children`         | `ReactNode`                        |                | `<Background>`, `<MiniMap>`, `<Controls>` and `<Panel>`.                 |

### `<Background>`

Marks every `gap` flow cells, under the edges.

| Prop      | Type                           | Default            | Meaning                  |
| --------- | ------------------------------ | ------------------ | ------------------------ |
| `variant` | `"dots" \| "lines" \| "cross"` | `"dots"`           | The mark.                |
| `gap`     | `XY`                           | `{ x: 8, y: 4 }`   | The spacing, in cells.   |
| `color`   | `string`                       | the theme's colour | The colour of the marks. |

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

### `<Handle>`

Declares where a custom node's edges attach. Render one per attachment point. A handle draws
nothing itself. The canvas marks the sources of the selected node, and the targets while you
connect. Handles that share a side are spread along it, in render order.

| Prop       | Type                                     | Default  | Meaning                                                  |
| ---------- | ---------------------------------------- | -------- | -------------------------------------------------------- |
| `type`     | `"source" \| "target"`                   | required | Whether edges leave or arrive here.                      |
| `position` | `"left" \| "right" \| "top" \| "bottom"` | required | The side of the node.                                    |
| `id`       | `string \| null`                         | `null`   | Names the handle, for `sourceHandle` and `targetHandle`. |

### `<DefaultNode>` and `<GroupNode>`

The built-in node components: `DefaultNode` for `default`, `input` and `output`, `GroupNode`
for `group`. Wrap or reuse them in your own `nodeTypes`. Both take the `NodeProps` that
every node component receives.

| Prop              | Type                           | Meaning                                                           |
| ----------------- | ------------------------------ | ----------------------------------------------------------------- |
| `id`              | `string`                       | The node's id.                                                    |
| `data`            | `Node["data"]`                 | The node's `data`.                                                |
| `type`            | `string`                       | The node's type.                                                  |
| `selected`        | `boolean`                      | Whether the node is selected.                                     |
| `dragging`        | `boolean`                      | Whether the node is being dragged.                                |
| `detail`          | `"full" \| "compact" \| "dot"` | The zoom level. At `dot`, the canvas draws the node itself.       |
| `connectTarget`   | `boolean`                      | Whether the node is the proposed target of a keyboard connection. |
| `width`, `height` | `number`                       | The node's fixed size in cells, when it has one.                  |

### `<FlowProvider>`

Shares one canvas with components outside `<Flow>`, such as a side panel that calls `fitView`.
Wrap the panel and the `<Flow>` in it. Without it, `<Flow>` keeps its own state.

| Prop              | Type        | Default  | Meaning                               |
| ----------------- | ----------- | -------- | ------------------------------------- |
| `children`        | `ReactNode` | required | The panel and the `<Flow>`.           |
| `defaultViewport` | `Viewport`  |          | The first view.                       |
| `fitView`         | `boolean`   |          | Fits every node in view at the start. |

## Hooks and helpers

| Export                                            | Use                                                                                                  |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `useNodesState`, `useEdgesState`                  | `useState`, plus the `on…Change` callback that applies the canvas's changes.                         |
| `useFlow()`                                       | `fitView`, `setViewport`, `setCenter`, `reveal`, `zoomIn`, `zoomOut`, `getNodes`, `select` and more. |
| `useViewport()`                                   | The current view and level of detail.                                                                |
| `applyNodeChanges`, `applyEdgeChanges`, `addEdge` | As in React Flow.                                                                                    |
| `composeFrame`, `hitTest`, `Grid`                 | The frame under the nodes, as pure functions, for tests and for rendering off the canvas.            |

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
- Curves need braille glyphs in the terminal's font. Set `braille={false}` where they are missing.
- A `group` node needs a `width` and a `height`.
- Edges are drawn in box characters. They cannot be arbitrary components.
- It does not lay nodes out for you. You give every node a `position`.

## Origin of the code

The orthogonal routing of edges, the bezier control points and the application of changes come
from xyflow (MIT), in [`src/vendor/xyflow`](src/vendor/xyflow/README.md). Rendering and
interaction are the package's own.

## Licence

MIT.
