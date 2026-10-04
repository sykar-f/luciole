# Latency: local typing, slow Server

Latency is a tiny playground for feeling what a slow Server does to the Client. An input, a hoverable box and a scrolling list stay local, with no request. A Server Function, `ping`, answers only after the simulated delay.

While the Server has not answered, you can keep typing, scrolling and hovering without a stutter.

## How do you run it?

```sh
LUCIOLE_LATENCY_MS=500 bunx luciole.sh example latency
```

From a clone of the repository, run this from its root:

```sh
bun install --frozen-lockfile
LUCIOLE_LATENCY_MS=500 bun packages/core/src/cli.ts dev --app examples/latency
```

The example has no `bun run` script. No API key and no network are needed.

Without `LUCIOLE_LATENCY_MS`, the answer is immediate and there is nothing to feel. The setting is the point.

## What can you try?

- Type in the input. The line `Input: …` at the bottom shows your text at once.
- Press Enter. The line under the input reads "Waiting for Server…", then "Server replied in N ms". N is close to `LUCIOLE_LATENCY_MS`.
- Move the mouse over the framed box. It lights up without waiting.
- Scroll the list of 100 rows with the mouse wheel.
- Press Ctrl+R to refresh the page. The heading shows "Refreshing…" while the Server answers.
- Press Ctrl+C to quit.

## How is it built?

Open these first:

- `components/Playground.tsx`: the input, the hover box, the list and the call to `ping`. All of it is local except that call.
- `actions/ping.ts`: the Server Function. It returns the text "Server replied".
- `app/page.tsx`: the Server page that hands `ping` to the playground.
- `app/layout.tsx`: the heading with the connection status, and the Ctrl+R binding.

## Which environment variables does it read?

| Variable             | Default | Effect                                                      |
| -------------------- | ------- | ----------------------------------------------------------- |
| `LUCIOLE_LATENCY_MS` | `0`     | Simulated round trip added to every request, half each way. |

The example's own code reads no other variable.

## What are its limits?

- The delay is simulated, not measured on a network. Real latency also varies from request to request.
- `ping` returns a fixed text and does no work, so N shows the delay and nothing else.
