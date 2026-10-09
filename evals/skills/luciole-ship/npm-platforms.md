---
expect-skill: luciole-ship
checks:
  - run: bash scripts/npm.sh
  - match:
      file: npm/@ada__notes/package.json
      pattern: '"bun-darwin-arm64":\s*"@ada/notes-darwin-arm64"'
  - match:
      file: npm/@ada__notes/package.json
      pattern: '"bun-linux-x64":\s*"@ada/notes-linux-x64"'
  - run: file npm/@ada__notes-linux-x64/bin/notes | grep -q 'ELF 64-bit.*x86-64'
  - run: bun run verify
---

Use the luciole-ship skill to write `scripts/npm.sh`, which prepares, from this directory, the
npm packages of this app as `@ada/notes`, version 0.1.0, for macOS on Apple Silicon and for
Linux x86_64, under `npm/`, so that users on either can run `luciole install @ada/notes`. The
script must work when I run it on this machine, and must not publish anything. Keep
`bun run verify` passing.
