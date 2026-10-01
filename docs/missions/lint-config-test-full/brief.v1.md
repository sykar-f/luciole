# Mission lint-config-test-full — the lint parity test compares every option

Role: worker
Agent: airtty-lint-config-test-full
Brief version: v1
Base: main @ 6991973
Branch: mission/lint-config-test-full
Prerequisites: lint-split-website
Harness: claude
Model: sonnet
Effort: high
Land: auto
Master: master-airtty
Hotfix: no

## Goal

`tests/lint-config.test.ts` fails on any difference between the effective oxlint configuration of the root and of `website/` other than `overrides`, `ignorePatterns` and `$schema`. Today its Zod schema strips every top-level option except `typeAware`, so drift in `typeCheck`, `respectEslintDisableDirectives` or any future option passes.

## Scope

Owned: `tests/lint-config.test.ts`.
Frozen: `.oxlintrc.json`, `website/oxlint.website.json`.
Out of bounds: everything else.

## Context

Never publish anything. Compare the two `--print-config` outputs whole (passthrough or record schema, or plain JSON) after removing only `overrides`, `ignorePatterns` and `$schema`; keep the guide-override assertion. The test must still run without `website/` installed.

## Acceptance

- Adding any top-level key (e.g. `"options": {"typeCheck": true}`) to one config only makes the test fail; show it in the delivery.
- The test passes on the unchanged configs.

Setup: `bun install --frozen-lockfile`, once in the fresh worktree.
Verify: `bun run check && bun run lint && bun run format:check`, then the tests you declare with `bun run test <paths>` → pass.

## Resources

None.

## Protocol

Follow the protocol of your role file. Your runtime directory is `.git/orchestra/missions/lint-config-test-full/`.
