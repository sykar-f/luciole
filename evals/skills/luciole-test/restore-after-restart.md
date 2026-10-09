---
expect-skill: luciole-test
timeout-minutes: 15
checks:
  - exists: tests/restore.test.ts
  - run: bun test tests/restore.test.ts
  # The same test with the restored session ignored must fail: it proves restore, not the Server.
  - run: |
      f=node_modules/@luciole-sh/core/src/client.tsx
      cp "$f" "$f.orig"
      perl -0pi -e 's/const restored = options\.session\?\.entries\.length/const restored = false && options.session?.entries.length/' "$f"
      if ! grep -q "const restored = false &&" "$f"; then mv "$f.orig" "$f"; echo "mutation not applied"; exit 2; fi
      bun test tests/restore.test.ts; status=$?
      mv "$f.orig" "$f"
      if [ "$status" -eq 0 ]; then echo "the test passes with restore broken"; exit 1; fi
  - run: bun run verify
---

Notes gives back the text a user typed but had not saved when the app restarts. Write a test
in `tests/restore.test.ts` that proves it: with autosave off, type into the "Welcome to Notes"
note, restart the app, and check that the typed text and its "● Unsaved" marker are back. Keep
`bun run verify` passing.
