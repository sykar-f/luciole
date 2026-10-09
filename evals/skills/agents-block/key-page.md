---
timeout-minutes: 15
checks:
  - run: bun run verify
  - exists: app/shortcuts/page.tsx
  - no-match:
      file: app/shortcuts/page.tsx
      pattern: ^\s*["']use client["']
  - run: >-
      for f in $(git diff --name-only HEAD; git ls-files -o --exclude-standard); do
      case $f in *layout.tsx) ;; *.ts|*.tsx)
      grep -qE '^[[:space:]]*.use client' "$f" && grep -qE 'useBindings|useKeyboard' "$f" && exit 0;;
      esac; done; exit 1
---

Add a page at the route `/shortcuts` that lists the app's keyboard shortcuts, and where the key
`b` goes back to the home page. Keep `bun run verify` passing.
