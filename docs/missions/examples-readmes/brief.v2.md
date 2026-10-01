# Mission examples-readmes — every example runs from a clean clone by its README

Role: worker
Agent: airtty-examples-readmes
Brief version: v2
Base: main @ f80912e
Branch: mission/examples-readmes
Prerequisites: none
Harness: claude
Model: sonnet
Effort: medium
Land: auto
Master: master-airtty
Hotfix: yes

## Goal

Each `examples/*` has a README that a newcomer can follow from a clean clone to a running app.

## Scope

Owned: `examples/*/README.md` (create for `forge`, `latency`, `notes`; fix the others).
Frozen: example code and `package.json`s.
Out of bounds: root `README.md` (another mission), `packages/`.

## Context

Context common to every mission of this batch: the owner prepares a first public release of luciole on GitHub, on the web (luciole.sh) and on npm. A read-only audit (2026-10-01) listed what is missing; this mission is one slice of it. Never publish anything: no `npm publish`, `bun publish` (a `--dry-run` is fine), no tag, no push outside your mission branch. The website docs content is out of scope for every mission (it will be rewritten).

Examples run from the monorepo root only (deps are `workspace:*` / `catalog:`): each README says so and gives the exact root command (root `package.json` scripts: `bun run forge`, `bun run chat`, …, or `bun packages/luciole/src/cli.ts dev --app examples/<x>` when there is none), prerequisites (Bun 1.4.2, API keys and their env vars, external CLIs such as claude/codex/opencode), and what to expect. Specifics: `examples/coder/README.md:33` uses `/home/ada/src/timers` (replace with `~/src/timers`); `coder` and `studio` READMEs warn that harness mode `full` disables the agent sandbox (`packages/harness/src/codex.ts:94`) and that the agent inherits the full environment; `chat` mentions its local `scripts/fake-openrouter.ts`.

## Acceptance

- `ls examples/*/README.md` lists all 11 examples.
- Every README names the exact launch command; each command you name exists (root script or file path) — list them in the delivery with how you checked.
- You launched each example that needs no API key at least once (`bun run test:pty:<x>` where a PTY smoke exists counts) and report the result per example.

Setup: `bun install --frozen-lockfile`, once in the fresh worktree.
Verify: `bun run check && bun run lint && bun run format:check`, then the tests you declare with `bun run test <paths>` → pass.

## Resources

None.

## Protocol

Follow the protocol of your role file. Your runtime directory is `.git/orchestra/missions/examples-readmes/`.

## v2 changes

- Effort: medium (the user's choice).
- Base: main @ f80912e (lint-split-website and load-sensitive-tests landed).
- `Hotfix: yes` is NOT a statement that this mission repairs main: main is red because of an orch environment defect (node_modules linked into the sweep checkout; the orch master owns the fix), and the user authorised dispatching this mission meanwhile; the flag is the only way orch lets a dispatch through. Do not try to fix main's red state.
