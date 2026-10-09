---
expect-skill: luciole-upgrade
setup: sh "$SCENARIO_DIR/fixtures/removed-api.sh"
checks:
  - run: bun run verify
  - match:
      file: actions/notes.ts
      pattern: "invalidate\\(\\{ tag: notesTag\\(owner\\) \\}\\)"
  - no-match:
      file: actions/notes.ts
      pattern: "revalidateTag|as unknown"
---

$luciole-upgrade I bumped @luciole-sh/core and @luciole-sh/markdown-editor in this app to the
current release and ran `bun install`. Now `bun run verify` fails. Finish the upgrade.
