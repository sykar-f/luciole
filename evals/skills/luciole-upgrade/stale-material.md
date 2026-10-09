---
expect-skill: luciole-upgrade
setup: sh "$SCENARIO_DIR/fixtures/age-material.sh"
checks:
  - run: bun run verify
  - run: node_modules/.bin/luciole skills status --agent agents
  - match:
      file: AGENTS.md
      pattern: "luciole-version: 0\\.1\\.0"
---

$luciole-upgrade I bumped @luciole-sh/core and @luciole-sh/markdown-editor in this app to the
current release and ran `bun install`. Finish the upgrade so that everything in the repository
matches that release.
