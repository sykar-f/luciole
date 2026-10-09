---
expect-skill: luciole-test
timeout-minutes: 15
checks:
  - exists: tests/editor.test.ts
  - run: bun test tests/editor.test.ts
  - match:
      file: tests/editor.test.ts
      pattern: "\\btag\\s*:"
  - no-match:
      file: tests/editor.test.ts
      pattern: "Bun\\.sleep|setTimeout\\("
  - run: bun run verify
---

Add `tests/editor.test.ts` with three tests of the note editor, autosave off, in this order,
each on the "Welcome to Notes" note:

1. typing into the note shows the "● Unsaved" marker;
2. the note, opened and left untouched, shows no "● Unsaved" marker;
3. after typing, Ctrl+S saves the note and the marker goes away.

Keep `bun run verify` passing.
