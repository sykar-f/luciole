---
expect-skill: luciole-debug
timeout-minutes: 15
setup: patch -p1 < "$SCENARIO_DIR/fixtures/client-hook-in-page.patch"
checks:
  - run: bun run verify
  - no-match:
      file: app/notes/[id]/page.tsx
      pattern: ^\s*["']use client["']
  - no-match:
      file: app/notes/[id]/page.tsx
      pattern: useState
  - match:
      file: app/notes/[id]/page.tsx
      pattern: noteOf\(
  - run: grep -rq "ctrl+w" app components
---

A teammate added Ctrl+W to the note page, `app/notes/[id]/page.tsx`: it shows how many words
the note holds, above the note. Since that change, `bun run verify` fails. Make it pass again,
and keep the feature: on a note's page, Ctrl+W still toggles the word count.
