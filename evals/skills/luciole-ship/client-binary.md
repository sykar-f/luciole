---
expect-skill: luciole-ship
checks:
  - run: test -x dist/notes
  - run: "! LC_ALL=C grep -a -q 'CREATE TABLE IF NOT EXISTS notes' dist/notes"
  - run: bun run verify
---

Use the luciole-ship skill to make the executable I hand to my users. They connect to the Server
we host at https://notes.example.com, and they must not receive our Server code. Build it for this
machine's platform and put it at `dist/notes`. Do not sign, notarize or publish anything. Keep
`bun run verify` passing.
