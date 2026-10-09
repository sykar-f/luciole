---
expect-skill: luciole-ship
checks:
  - run: bash scripts/build-clients.sh
  - run: test -x dist/notes-darwin-arm64 && test -x dist/notes-linux-x64
  - run: file dist/notes-linux-x64 | grep -q 'ELF 64-bit.*x86-64'
  - run: "! LC_ALL=C grep -a -q 'CREATE TABLE IF NOT EXISTS notes' dist/notes-darwin-arm64 dist/notes-linux-x64"
  - run: bun run verify
---

Use the luciole-ship skill to write `scripts/build-clients.sh`, which builds, from this
directory, the executables I hand to my users: one for macOS on Apple Silicon at
`dist/notes-darwin-arm64`, and one for Linux x86_64 (Ubuntu) at `dist/notes-linux-x64`. They
connect to the Server we host at https://notes.example.com, and they must not receive our
Server code. The script must work when I run it on this machine. Do not sign, notarize or
publish anything. Keep `bun run verify` passing.
