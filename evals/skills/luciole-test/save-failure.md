---
expect-skill: luciole-test
timeout-minutes: 15
checks:
  - exists: tests/save-failure.test.ts
  - run: bun test tests/save-failure.test.ts
  - match:
      file: tests/save-failure.test.ts
      pattern: "\\b(network|fetch|transport|wrapTransport)\\s*:"
  - no-match:
      file: tests/save-failure.test.ts
      pattern: "Bun\\.sleep|setTimeout\\("
  - run: bun run verify
---

When a note's save cannot reach the Server, Notes keeps the typed text and tells the user.
Write a test in `tests/save-failure.test.ts` that checks what the user sees when the saves of
the "Welcome to Notes" note fail. Keep `bun run verify` passing.
