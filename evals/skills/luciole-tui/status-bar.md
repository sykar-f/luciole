---
expect-skill: luciole-tui
timeout-minutes: 15
checks:
  - run: grep -rqE "useConnection\(" app components
  - run: grep -rlE "×" app components | xargs grep -lE "useTerminalDimensions\(" | grep -q .
  - run: "! grep -rqE \"process\\.stdout\\.(columns|rows|on)\" app components"
  - run: bun run verify
---

Add a one-line status bar at the very bottom of the window. On its left, the state of the
connection to the Server, in the framework's own words (Connected, Disconnected…). On its
right, the terminal's size as `columns×rows`, for example `120×40`, which changes as soon as
the user resizes the terminal. The rest of the window keeps its layout. Keep
`bun run verify` passing.
