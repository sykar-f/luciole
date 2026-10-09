---
expect-skill: luciole-debug
timeout-minutes: 15
setup: patch -p1 < "$SCENARIO_DIR/fixtures/duplicate-on-drop.patch"
checks:
  - run: bun run verify
  - no-match:
      file: components/commands.ts
      pattern: \.catch\(\s*(async\s*)?\(\)\s*=>\s*createNote
  - match:
      file: components/commands.ts
      pattern: createNote\([\s\S]*createNote\(
  - match:
      file: REPRO.md
      pattern: LUCIOLE_FAULT=["']?[a-z:.,0-9]*drop
---

Users on a flaky connection report that Ctrl+N sometimes creates two new notes instead of
one. Find why and fix it. Keep the second try where it cannot create a duplicate.

Then write in `REPRO.md` the command that starts this app on a network that reproduces the
problem on a developer's machine. Keep `bun run verify` passing.
