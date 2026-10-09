---
expect-skill: luciole-test
timeout-minutes: 15
checks:
  - exists: tests/create-note.test.ts
  - run: bun test tests/create-note.test.ts
  # Server Functions run only in the built Server: a test reaches them through the app.
  - no-match:
      file: tests/create-note.test.ts
      pattern: "[\"']\\.\\.?/(\\.\\./)*(actions|server)/"
  - no-match:
      file: package.json
      pattern: server-only
  - run: bun run verify
---

`createNote` in `actions/notes.ts` adds a note. Write a test in `tests/create-note.test.ts`
that checks it: after a call, the list of notes holds one note more. Keep `bun run verify`
passing.
