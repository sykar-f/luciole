# Slow screens, extra renders and the requests behind them

The DevTools are a terminal UI in a second pane: an agent without that pane cannot read them.
Ask the user to run them, or to export a recording and hand you its file.

## Start them (the user runs both panes, from the app's root)

```sh
bunx luciole devtools                      # pane 1: the DevTools
eval "$(bunx luciole devtools --env)"      # pane 2: exports LUCIOLE_DEVTOOLS and BUN_OPTIONS
bun run dev                                # pane 2: then the app
```

- `--listen 1|<socket>|ws://host:port` picks the address; `--demo` replays a scripted run of
  Notes; `--replay file.json` opens a recording.
- Under `luciole start` (`NODE_ENV=production`) both processes ignore `LUCIOLE_DEVTOOLS`:
  inspect a development run.
- Network fills but Components stays empty: pane 2 ran the app without the `eval` line.

## What to look for

| Panel        | Sign                               | Meaning and usual fix                                                                                |
| ------------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1 Network    | `↳` in the first column            | A sequential waterfall: a request waited for another one's response. Start them together.            |
| 1 Network    | `⟳`                                | One cause rendered a page twice, for instance `invalidate()` on the Server and again in a component. |
| 1 Network    | cache column `miss` on every visit | The read is not cached (`"use cache"`), or its tag is invalidated too often.                         |
| 2 Components | `⚠ unnecessary`                    | Rendered only because its parent did: equal props, state and context. Wrap it in `memo()`.           |
| 4 Router     | a match's age and status           | Whether the page came from the router's cache (`staleTime`) or a request.                            |
| 7 Conditions | latency, jitter, faults            | Change the network while the app runs, instead of restarting with `LUCIOLE_*` variables.             |

<kbd>Shift+E</kbd> writes `luciole-devtools-<date>.json` (the raw events, which `--replay`
opens) and a HAR 1.2 file in the directory the DevTools run in. Both are text: read them to
compare request timings and causes.

## Without the DevTools

- `<DebugOverlay limit? />` from `@luciole-sh/core/client`, rendered in the layout, shows the
  requests, the open requests, the bytes, the last round trip and the latest events. The
  starter binds it to <kbd>Ctrl+T</kbd>.
- `useApplication().onEvent(listener)` receives every `request`, `response` (with `ms`),
  `end`, `error` (with `outcome`), `navigation`, `invalidate`, `loader` and `failure` event.
  Keep the listener light: it runs on the request's path.
- `instrumentTracing(app, tracer)` from `@luciole-sh/core/client` opens an OpenTelemetry span
  per request (`luciole.render` or `luciole.action`).
- To measure in a test rather than by eye, use the `luciole-test` skill.

See `node_modules/@luciole-sh/core/docs/guides/devtools.md` and the "Observe requests and
navigations" section of `node_modules/@luciole-sh/core/docs/reference/api.md`.
