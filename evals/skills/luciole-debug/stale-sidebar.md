---
expect-skill: luciole-debug
timeout-minutes: 15
setup: patch -p1 < "$SCENARIO_DIR/fixtures/stale-sidebar.patch"
checks:
  - run: bun run verify
  - run: grep -rq "useInvalidation(" components app
  - no-match:
      file: components/commands.ts
      pattern: notesList\.load\(\)[\s\S]*notesList\.load\(\)
  - no-match:
      file: components/notes-list.ts
      pattern: setInterval
---

Renaming a note, or typing in it until it saves, updates the note's own page, but the list of
notes on the left keeps the old title and the old excerpt until the app restarts. Find why and
fix it. Keep `bun run verify` passing.
