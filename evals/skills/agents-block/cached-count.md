---
timeout-minutes: 15
checks:
  - run: bun run verify
  - exists: app/stats/page.tsx
  - match:
      file: server/stats.ts
      pattern: cacheTag\(
  - no-match:
      file: server/stats.ts
      pattern: get(Optional)?Session
---

Add a page at the route `/stats` that shows how many notes the signed-in user has. Put the
read in `server/stats.ts` and cache it with `"use cache"`, so that it updates when the user
creates, saves or deletes a note. Keep `bun run verify` passing.
