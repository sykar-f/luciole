---
name: luciole-debug
description: Debug a luciole app. Use when `luciole build` or `bun run verify` fails with a boundary error ("is Client-only React", "Server-only import in Client graph", "must declare \"use client\""), a route or params type error, or "Cannot resolve"; when a page shows its error screen, or a generic "Server render failed" only in production (`luciole start`) while `bun run dev` shows the real message; when the status reads Disconnected, Incompatible build (409) or Authentication required (401); when a Server Function call fails, runs twice or duplicates data on a flaky network; when data or a list stays stale after a change until restart; or when a screen is slow or renders too often and you need `luciole devtools`, `<DebugOverlay />`, `onEvent` or tracing. Also for "it works in dev but not in production", "reproduce a network bug", "add latency or faults".
---

# Debug a luciole app

Reproduce, read the signal the symptom points to, fix on the right side of the Client/Server
boundary, then verify with `bun run verify`. To lock the fix in with a regression test, use
the `luciole-test` skill.

The docs of the installed version are in `node_modules/@luciole-sh/core/docs/`.
`node_modules/@luciole-sh/core/docs/reference/troubleshooting.md` lists each error message
with its cause and fix: search it for the message's first words.

## The build refuses a module

`luciole build` prints `<file>:<line>:<col>: <message>`, then `via a → b → c`: the chain of
imports from the page to the offending module. Fix where the chain crosses the boundary, not
at its leaf.

| Message                                                                                            | Fix                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<hook> is Client-only React: a Server Component cannot use it. Add "use client"…`                 | In a page, do not take the "Add `use client`" advice: move the hook and the UI it drives into a component file of its own (below).                                          |
| `Server-only import in Client graph: <module>` / `Server-only source in Client graph`              | A `"use client"` file reaches a `server/` directory, `@luciole-sh/core/server` or `server-only`. Read the data in the page and pass it as props, or call a Server Function. |
| `"use cache" module in Client graph`                                                               | Same: cached reads run on the Server only.                                                                                                                                  |
| `OpenTUI native runtime is Client-only`                                                            | A page or Server module imports `@opentui/*`. Pages render `<box>` and `<text>` without that import; terminal hooks go in a Client Component.                               |
| `layout.tsx must declare "use client" and a default export` (also `loading`, `error`, `not-found`) | These files render without the Server: start them with `"use client"`.                                                                                                      |
| `"use server" supports named exported async function declarations only`                            | Write `export async function name() {}` in that file; move helpers and constants elsewhere.                                                                                 |
| A TypeScript error on a link's `to` or `params`                                                    | `app/routeTree.gen.ts` is stale or the link is wrong. Run `bun run build` to regenerate it, never edit it, then fix the link.                                               |

A page that reads data (`await`, `getSession()`, an import from `server/`) stays a Server
Component. When it gains state or key bindings, the fix is a split:

1. a new file under `components/` that starts with `"use client"` and holds the `useState`,
   `useBindings` and the UI they drive;
2. the page keeps its reads and renders that component, passing serialisable props.

Adding `"use client"` to such a page trades the first error for `Server-only import in Client
graph`; turning the page's read into a Client-side fetch hides the error and loses the Server
render. See `node_modules/@luciole-sh/core/docs/concepts/client-components.md`.

## A page fails at run time

A page that throws reaches the nearest `error.tsx`. In production the Client receives only
"Server render failed": React's production Flight drops the message, and the Server logs
nothing for it. So:

- To read the real error, reproduce under `bun run dev`, where `error.tsx` gets the message.
- A condition the user must understand is an answer, not a throw: return the message as the
  page's own output, in the app's own pane (a Server page renders Client Components too).
  Editing `error.tsx` cannot bring a production message back.
- `notFound()` is for a record that does not exist: it shows `not-found.tsx` and tells the
  router the page is missing. Do not route another message through its `what`.
- `useApplication().onEvent` receives a `failure` event with the page's `path` and `message`
  for each error screen.

See `node_modules/@luciole-sh/core/docs/concepts/loading-and-errors.md`.

## A call fails, runs twice or loses data

Every failed request throws a `TransportError` (from `@luciole-sh/core/client`). Branch on its
`outcome`, never on "it threw":

| `outcome`              | Did the Server run the function? | What to do                                                                                                                                                                         |
| ---------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `not-sent`, `rejected` | No                               | Safe to retry, or to say "not saved".                                                                                                                                              |
| `unknown`              | Maybe                            | A retry may run it twice. Send an operation ID the Server stores so a retry is idempotent (Notes' saves and `getOperation`), reload what the Server holds, or let the user decide. |

The transport never retries; a `.catch(() => call())` retries `unknown` too and duplicates
writes. See `node_modules/@luciole-sh/core/docs/concepts/server-functions.md`.

Reproduce network bugs with the Client's variables, on `bun run dev` or `luciole`:

```sh
LUCIOLE_LATENCY_MS=300 LUCIOLE_FAULT=drop:0.3 bun run dev
```

`LUCIOLE_FAULT` takes `refuse` (gives `not-sent`), `drop` (the Server ran, the response is lost:
`unknown`) and `cut` (`unknown`), each with a probability: `refuse:0.1,drop:0.05`. Also
`LUCIOLE_JITTER_MS` and `LUCIOLE_CHUNK_DELAY_MS`. A test's Server ignores them: a test passes
`latencyMs` and `network` to `openClient` instead (the `luciole-test` skill). See
`node_modules/@luciole-sh/core/docs/guides/latency-and-faults.md`.

## The connection status says why

`useConnection()` gives `status`, `error` (why the last refresh failed) and `buildError` (a
failed rebuild under `luciole dev`):

| `status`                  | Cause and fix                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| "Disconnected"            | The Server is down or out of reach. A launched app logs to `$XDG_STATE_HOME/luciole/<app>/server.log`. |
| "Incompatible build"      | A `409`: Client and Server come from two builds. Run `luciole build`, restart both. No code to change. |
| "Authentication required" | A `401`: `LUCIOLE_TOKEN` differs between the two, or `server/auth.ts` returned no session.             |

## Data stays stale after a change

The framework refreshes nothing after a Server Function by itself. Find which read is stale:

- **A page** (its Server render) reloads when the writing Server Function calls
  `invalidate()`, `invalidate("/path")` or `invalidate({ tag })` from `@luciole-sh/core/server`.
  If it does not, add the call there.
- **Data a Client Component loads itself** through a Server Function (a list in a layout, a
  counter) never reloads with the routes. The hook that loads it subscribes with
  `useInvalidation(listener)` from `@luciole-sh/core/client` and reloads in the listener. One
  subscription covers every Server Function that invalidates; a reload added after each call
  site misses the others, and polling hides the bug.

A lost response invalidates nothing. See
`node_modules/@luciole-sh/core/docs/concepts/server-functions.md` and
`node_modules/@luciole-sh/core/docs/concepts/cache.md`.

## Slow screens and extra renders

Read [references/devtools.md](references/devtools.md) when a screen is slow, renders too
often, or you need to see the requests: it covers `luciole devtools`, `<DebugOverlay />`,
`onEvent` and OpenTelemetry tracing.

## Gotchas

- A page stays a Server Component: give its state and keys to a `"use client"` component it
  renders.
- `app/routeTree.gen.ts` comes from the build: regenerate it with `bun run build`.
- Show an expected failure as the page's own output; keep throws for bugs.
- Retry a Server Function on `not-sent` or `rejected`; retry on `unknown` only when an
  operation ID makes the call idempotent.
- Reload Client-loaded data in `useInvalidation`, where the data is loaded.
- Treat "Incompatible build" as a deployment issue: rebuild and restart both processes.
- Reproduce a production-only error under `bun run dev` to see its message.
