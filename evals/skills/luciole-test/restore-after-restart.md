---
expect-skill: luciole-test
timeout-minutes: 15
checks:
  - exists: tests/restore.test.ts
  - run: bun test tests/restore.test.ts
  - match:
      file: tests/restore.test.ts
      pattern: "\\btag\\s*:"
  - run: bun run verify
---

Notes gives back the text a user typed but had not saved when the app restarts. Write a test
in `tests/restore.test.ts` that proves it: with autosave off, type into the "Welcome to Notes"
note, restart the app, and check that the typed text and its "● Unsaved" marker are back. Keep
`bun run verify` passing.
