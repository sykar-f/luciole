# Mission lint-split-website — a clean clone passes verify without website/ installed

Role: worker
Agent: airtty-lint-split-website
Brief version: v1
Base: main @ 6991973
Branch: mission/lint-split-website
Prerequisites: none
Harness: claude
Model: sonnet
Effort: high
Land: auto
Master: master-airtty
Hotfix: yes

## Goal

`bun install && bun run verify` at the repo root passes in a clean clone where `website/` has no `node_modules` and no `.astro/` types. Today the root `oxlint` (type-aware, `.oxlintrc.json` `typeAware: true`) lints `website/` too, and fails with `File 'astro/tsconfigs/strict' not found` plus `no-unsafe-*` errors in `website/astro.config.mjs`. Main is red for this reason in orch's main sweep (a clean checkout), and a contributor who clones the repo hits the same wall. CI hides it by installing `website/` and running `astro sync` before verify (`.github/workflows/ci.yml`, around lines 19-22).

## Scope

Owned: `.oxlintrc.json`, the `lint` script of the root `package.json` (and a new `lint:website` script if you add one), `website/package.json` scripts, `.github/workflows/ci.yml`.
Frozen: the lint rules themselves (no rule relaxed, no new disable comment); every other script.
Out of bounds: website content; every package under `packages/` and `examples/`.

## Context

Context common to every mission of this batch: the owner prepares a first public release of luciole on GitHub, on the web (luciole.sh) and on npm. A read-only audit (2026-10-01) listed what is missing; this mission is one slice of it. Never publish anything: no `npm publish`, `bun publish` (a `--dry-run` is fine), no tag, no push outside your mission branch. The website docs content is out of scope for every mission (it will be rewritten).

This is a hotfix: main is red. The website must still be linted somewhere (CI keeps the guarantee): move its linting to a step that runs only where `website/` is installed (for example a `lint:website` script run from CI's website steps, with the `website/src/pages/guide/*.astro` overrides that `.oxlintrc.json` currently carries). Do not work around with a retry, a skip of the whole lint, or `|| true`.

## Acceptance

- In a fresh `git worktree` of your branch where only `bun install --frozen-lockfile` ran at the root (no install in `website/`), `bun run lint` exits 0. Paste the command and its output in the delivery.
- Root `.oxlintrc.json` ignores `website/**`; the website lint runs in CI after `website/`'s install (diff of `ci.yml`).
- With `website/` installed and synced, the new website lint exits 0 (paste the output).
- This mission changes the verification machinery: run one full `bun run verify` in the fresh worktree before delivery and paste its tail.

Setup: `bun install --frozen-lockfile`, once in the fresh worktree.
Verify: `bun run check && bun run lint && bun run format:check`, then the tests you declare with `bun run test <paths>` → pass.

## Resources

None.

## Protocol

Follow the protocol of your role file. Your runtime directory is `.git/orchestra/missions/lint-split-website/`.
