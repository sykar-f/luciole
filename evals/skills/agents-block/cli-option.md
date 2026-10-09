---
timeout-minutes: 15
checks:
  - run: bun run verify
  - match:
      file: app/args.ts
      pattern: defineArgs
  - run: grep -rqE "from [\"'][./]*(app/)?args[\"']" app/notes server actions components
---

Add a command-line option `--autosave-ms <n>` to the app that sets how long after the last
keystroke a note saves itself, with a line in the app's `--help`. Keep `NOTES_AUTOSAVE_MS` as
its fallback. Keep `bun run verify` passing.
