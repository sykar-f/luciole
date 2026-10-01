# Mission community-files — community files and an honest root README status

Role: worker
Agent: airtty-community-files
Brief version: v2
Base: main @ f80912e
Branch: mission/community-files
Prerequisites: none
Harness: claude
Model: sonnet
Effort: medium
Land: auto
Master: master-airtty
Hotfix: yes

## Goal

A visitor of the public GitHub repo finds how to contribute, how to report a vulnerability, what changed, and exactly what runs where.

## Scope

Owned: new `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`; the status / requirements section of root `README.md`; the workflow `name:` in `.github/workflows/ci.yml` (`MVP` → `CI`) and nothing else in that file.
Frozen: `LICENSE` (its copyright line is the owner's decision); CI steps.
Out of bounds: `examples/*/README.md`, `packages/*`, `docs/`, website.

## Context

Context common to every mission of this batch: the owner prepares a first public release of luciole on GitHub, on the web (luciole.sh) and on npm. A read-only audit (2026-10-01) listed what is missing; this mission is one slice of it. Never publish anything: no `npm publish`, `bun publish` (a `--dry-run` is fine), no tag, no push outside your mission branch. The website docs content is out of scope for every mission (it will be rewritten).

README status facts to state precisely: development and the `luciole` CLI require Bun 1.4.2 (luciole uses Bun.Terminal, Bun.serve, Bun.build, bun:sqlite…); `@luciole/flow` and `@luciole/editor` have no Bun dependency; a compiled Client runs without Bun (CI tests it in Debian and Alpine, `scripts/linux-client.ts`); CI covers macOS and Linux, Windows is untested; the desktop app (`packages/desktop`) is an experimental macOS-arm64 prototype, unsigned (`docs/DESKTOP.md` ~126-136); examples run from the monorepo root. Keep the "experimental" status line and the "No package is published" wording: a later release mission updates it. SECURITY.md: private reporting via GitHub security advisories; scope includes PTY, sandbox, the dev server. CONTRIBUTING.md: setup (`bun install`, `website/` install for the site), `bun run verify`, commit convention (Conventional Commits, body explains why). CHANGELOG.md: Keep a Changelog format, an `Unreleased` section summarising current features from the README.

## Acceptance

- The three files exist; every command they cite exists in `package.json` scripts or the repo (list the checks in the delivery).
- README states Bun requirement, OS support, Windows untested, desktop experimental (diff).
- `ci.yml` diff is the `name:` line only.

Setup: `bun install --frozen-lockfile`, once in the fresh worktree.
Verify: `bun run check && bun run lint && bun run format:check`, then the tests you declare with `bun run test <paths>` → pass.

## Resources

None.

## Protocol

Follow the protocol of your role file. Your runtime directory is `.git/orchestra/missions/community-files/`.

## v2 changes

- Effort: medium (the user's choice).
- Base: main @ f80912e (lint-split-website and load-sensitive-tests landed).
- `Hotfix: yes` is NOT a statement that this mission repairs main: main is red because of an orch environment defect (node_modules linked into the sweep checkout; the orch master owns the fix), and the user authorised dispatching this mission meanwhile; the flag is the only way orch lets a dispatch through. Do not try to fix main's red state.
