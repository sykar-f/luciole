---
expect-skill: luciole-app
timeout-minutes: 15
checks:
  - exists: app/about/page.tsx
  - match:
      file: app/about/page.tsx
      pattern: About Notes
  - run: bun run verify
---

Add a page at the route `/about` that shows the text "About Notes". Keep `bun run verify`
passing.
