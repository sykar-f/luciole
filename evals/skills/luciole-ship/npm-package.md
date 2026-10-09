---
expect-skill: luciole-ship
checks:
  - match:
      file: npm/@ada__notes/package.json
      pattern: '"binaries":\s*\{\s*"bun-[a-z0-9-]+":\s*"@ada/notes-'
  - run: test -n "$(find npm -path '*/bin/notes' -type f -perm -u+x)"
  - run: bun run verify
---

Use the luciole-ship skill to prepare this app for npm as `@ada/notes`, version 0.1.0, for this
machine's platform only, so that users can run `luciole install @ada/notes`. Write the packages
under `npm/` and do not publish them. Keep `bun run verify` passing.
