---
expect-skill: luciole-debug
timeout-minutes: 15
setup: patch -p1 < "$SCENARIO_DIR/fixtures/opaque-production-error.patch"
checks:
  - run: bun run verify
  - no-match:
      file: app/notes/[id]/page.tsx
      pattern: throw new Error\(\s*["']This note is too large
  - run: grep -rq "too large to open" app components
  - no-match:
      file: app/error.tsx
      pattern: too large
  - no-match:
      file: app/notes/[id]/page.tsx
      pattern: notFound\(\s*["']This note is too large
  - no-match:
      file: app/notes/[id]/not-found.tsx
      pattern: too large
---

Opening a very large note works under `bun run dev`: the app says "This note is too large to
open". In the production build, started with `luciole start`, the same note shows a generic
error in its place, and users do not know why. Make users see "This note is too large to open"
in production too. Keep `bun run verify` passing.
