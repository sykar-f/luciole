---
expect-skill: luciole-tui
timeout-minutes: 15
checks:
  - exists: app/shell/page.tsx
  - run: grep -rqE "<Terminal\b" app components
  - run: grep -rqE "prefix=" app components
  - run: grep -rqE "active=" app components
  - no-match:
      file: package.json
      pattern: node-pty|xterm
  - run: bun run verify
---

Add a page at the route `/shell` that shows two panes side by side, each with a border: the
user's own shell (`$SHELL`) on the left and `top` on the right, both running live in the
pane. Typing goes to one pane at a time; Ctrl+O then O moves the keyboard to the other pane,
and the pane that has the keyboard shows a brighter border. Keep `bun run verify` passing.
