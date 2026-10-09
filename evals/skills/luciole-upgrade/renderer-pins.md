---
expect-skill: luciole-upgrade
setup: sh "$SCENARIO_DIR/fixtures/misaligned-pins.sh"
checks:
  - run: bun run verify
  - absent: node_modules/@luciole-sh/core/node_modules/@opentui/core
  - run: git diff --quiet "$(git rev-list --max-parents=0 HEAD)" -- components app
---

$luciole-upgrade I bumped @luciole-sh/core in this app to the current release and ran
`bun install`. Now `bun run verify` fails. Finish the upgrade.
