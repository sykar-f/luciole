---
expect-skill: luciole-tui
timeout-minutes: 15
checks:
  - run: grep -rqE "<KeyHelp" app components
  - run: grep -rqE "key:\s*\"ctrl\+d\"" app components
  - run: grep -rqE "desc:" app components
  - run: bun run verify
---

Add a keyboard shortcut, Ctrl+D, that deletes the note on screen. Then show the window's
shortcuts on a one-line footer at the bottom of the window: Ctrl+D, and also the existing
Ctrl+N (new note), Ctrl+L (list) and Ctrl+F (search). The footer must stay in step with the
shortcuts: when one is added or removed, the footer follows without editing it. Keep
`bun run verify` passing.
