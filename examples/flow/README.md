# flow — a CI pipeline on a node canvas

A pipeline editor in your terminal. The steps of a CI (checkout, install, lint, typecheck, test,
build, e2e, deploys) sit on a canvas like React Flow's, drawn by
[`@luciole-sh/flow-graph`](../../packages/flow-graph/README.md). You move, add, connect, rename
and delete steps, then start a run that lights them up one after the other.

It shows a Server that owns the data, Server Functions that validate every change, and a live
Server Function that streams a run to every Client.

## Run it

Run the example from a release of luciole, with no clone:

```sh
bunx luciole.sh example flow
FLOW_RUN_SCALE=0.3 bunx luciole.sh example flow   # runs three times shorter
```

Or from a clone of the repository, at its root. The example depends on workspace packages, so
it does not start from its own folder. You need Bun 1.4.2, and `bun install --frozen-lockfile`
once. It needs no API key and no network.

```sh
bun run flow
FLOW_RUN_SCALE=0.3 bun run flow
```

`bun run flow` is `luciole dev --app examples/flow`. You should see the pipeline `web · main`,
with `never run` in the top line.

To run the production build, a Server and a Client, from the root of the clone:

```sh
bun packages/core/src/cli.ts build --app examples/flow
bun packages/core/src/cli.ts start --role server --app examples/flow
bun packages/core/src/cli.ts start --role client --app examples/flow --url http://127.0.0.1:3000
```

The first `start` prints `{"ready":true,"port":3000,…}`. Run the second in another terminal.

The whole canvas fits from about 160 columns. Below that, `fitView` picks the `compact` zoom
level, which shows labels only. Press `=` to get the full detail back.

## What to try

Press `r` to start a run. Each step starts when all its upstream steps have passed, and the
steps after a failure are skipped. `e2e` is flaky on purpose: it fails on odd runs, so the
first run shows a failure and `production` is skipped. Run again and it passes.

Edges into a running step are animated. Edges out of a passed step are green, and out of a
failed step red.

| Keys                 | Action                                                 |
| -------------------- | ------------------------------------------------------ |
| `tab`, `Shift+tab`   | Next, previous step                                    |
| `]`, `[`, `}`, `{`   | Downstream, upstream, siblings                         |
| `h j k l`, `H J K L` | Move the view, move the step                           |
| `a`                  | Add a step after the selection, linked to it, or alone |
| `n`                  | Rename the step (`Enter` saves, `Esc` cancels)         |
| `c`, `tab`…, `Enter` | Connect the step to the proposed target                |
| `e`, `x`             | Select the step's links, delete the selection          |
| `r`                  | Start a run                                            |
| `-`, `=`, `0`        | Zoom out (labels, then dots), zoom in, fit everything  |

With the mouse:

- click to select
- drag a step or the background
- drag from the `●` of the selected step to another step to connect them
- use the wheel to move the view, and Ctrl+wheel to zoom
- click in the minimap to go there

## How it is built

Open these files first:

- `server/pipeline.ts` holds the pipeline in memory, so it starts from scratch at each start,
  and simulates the runs.
- `actions/pipeline.ts` exposes the Server Functions, with arguments validated by Zod:
  `loadPipeline`, `moveSteps`, `addStep`, `renameStep`, `removeElements`, `connectSteps`,
  `startRun`, and the live `watchRun`.
- `components/PipelineEditor.tsx` wires the canvas to those functions and reads `watchRun` with
  `useLive`. It is also where the editing keys `a`, `n` and `r` live.
- `components/StepNode.tsx` draws one step.
- `app/page.tsx` renders the pipeline on the first display.

Pan, zoom, drag, selection, keyboard navigation and the inspector all stay in the Client, with no
round trip. Moves are sent when they settle, at the end of a drag or 250 ms after a burst of
`H J K L`.

The Server refuses a link that would close a cycle, a duplicate, and a deletion during a run.
The Client then shows the reason and reloads the pipeline as the Server keeps it
(`loadPipeline`), without guessing.

To check the example, run `bun run test:pty:flow`. [`scripts/pty/flow.ts`](../../scripts/pty/flow.ts)
builds the example, starts a production Server and Client in a 160×40 PTY, and goes through
the whole journey above. A second Client then reads the pipeline back, which proves the link and
the move reached the Server. The last screen goes to `docs/flow-pty-frame.txt`, which git
ignores.

## Environment variables

The Server reads one.

| Variable         | Default | Role                                                                             |
| ---------------- | ------- | -------------------------------------------------------------------------------- |
| `FLOW_RUN_SCALE` | `1`     | Multiplies the duration of a run. Below 1 it is shorter, with a floor of `0.01`. |

## Limits

- The pipeline lives in the Server's memory. Restarting the Server resets it.
- The runs are simulated: a step takes a time that grows with the length of its name, and runs no command.
- A pipeline holds at most 60 steps, and a name at most 24 characters.
